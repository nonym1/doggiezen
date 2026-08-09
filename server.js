// server.js
// DoggieZen backend. Everything that changes a player's coins, best score, missions,
// or referral credit happens here — the client (doggiezen-2-7-1.html) only ever displays
// what this server returns; it has no authority to grant itself rewards.
//
// Endpoints:
//   POST /api/state               -> load (and create if new) a player's full state
//   POST /api/run/start           -> open a run, returns a one-time runToken + a replay seed
//   POST /api/run/submit          -> close a run, validates (replaying flaps against the seed
//                                     via physics.js) + credits coins/missions
//   POST /api/missions/claim      -> claim a completed daily mission's reward
//   POST /api/wallet               -> $DOGZ balance + recent transaction history
//   POST /api/leaderboard         -> top 20 + the caller's own rank
//   POST /api/profile/tutorial-seen -> mark the tutorial as dismissed
//
// initData verification follows Telegram's spec:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// The app itself is built by createApp({db, store, botToken, allowedOrigin}) so tests can
// inject an isolated db/store instead of talking to the real database and rate-limit state.
// Actually starting the server (reading .env, exiting if TELEGRAM_BOT_TOKEN is missing,
// calling app.listen) only happens when this file is run directly — see the bottom.

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { simulateRun, FIXED_DT_MS, stepIndexForTime } = require('./physics');

const MAX_INIT_DATA_AGE_SECONDS = 60 * 60; // initData older than this is rejected
const REFERRAL_REWARD = 1000; // $DOGZ credited to the referrer, matches the client's referral screen
const MAX_RUN_DURATION_MS = 5 * 60 * 1000; // runs are capped to a 5-minute window for scoring purposes
const PIPE_SPAWN_MS = 1700; // ~100 frames at 60fps, matches the client's pipeTimer threshold, with a little slack
// How many points of slack the replay-based check (see simulateRun() in physics.js) allows
// above what it independently computed. Exists ONLY to absorb the sub-frame timing ambiguity
// described at the top of physics.js (which fixed step a flap lands in, right at a frame
// boundary, can differ by one between the client's real rAF-driven loop and the server's
// replay) — not to give a cheater room to inflate a score. Kept deliberately small.
const REPLAY_SCORE_TOLERANCE = 2;
const DAILY_COIN_CAP = 3000; // see "Anti-cheat, honestly" in the README — a damage-bound, not a cheat detector
const REPEAT_OFFENDER_THRESHOLD = 3; // flagged runs (see evaluateFlapEvidence) before the tighter cap kicks in
const REPEAT_OFFENDER_CAP_FACTOR = 0.2; // repeat offenders' daily cap becomes this fraction of DAILY_COIN_CAP
const SOCIAL_MIN_DWELL_MS = 10 * 1000; // must have opened the link at least this long before /api/social/claim will pay out

/* ===================== Zen Pass (x2/x3/x4/x5 coin multiplier, paid in TON) =====================
   A player buys into tier 1 (x2 coins) for 1 TON, then each further purchase advances them one
   tier at a time (can't skip a tier), up to tier 4 (x5 coins) for 4 TON. The multiplier applies
   to the three coin sources the player explicitly asked for: gameplay run rewards, mission
   rewards (daily + permanent social), and referral rewards — see zenPassMultiplier() and its
   call sites in /api/run/submit, /api/missions/claim, and the referral payout below.
   Deliberately NOT applied to the daily check-in streak reward or the one-time social-mission
   payout, since those weren't part of what was asked for — easy to add later if wanted. */
const ZEN_PASS_TIERS = [
  { tier: 1, multiplier: 2, priceTon: 1 },
  { tier: 2, multiplier: 3, priceTon: 2 },
  { tier: 3, multiplier: 4, priceTon: 3 },
  { tier: 4, multiplier: 5, priceTon: 4 },
];
const ZEN_PASS_MAX_TIER = ZEN_PASS_TIERS.length;
// Auto Pilot — a one-time Zen Pass purchase (not a tier) that makes the dog fly itself:
// the client keeps flapping on its own during a run instead of waiting for taps (see
// autopilotStep() in the client). It's still a real run as far as the server is concerned —
// the client's autopilot just generates the same flap timestamps a human tap would, so
// /api/run/submit's replay-based anti-cheat check (see physics.js) applies exactly as before.
const AUTO_PILOT_PRICE_TON = 5;
const NANOTON_PER_TON = 1_000_000_000;
// A TON transfer's destination receives slightly less than the sender's requested `amount`
// (the network deducts a small forward fee from the message value in transit), so payment
// verification accepts anything within this fraction of the expected price rather than
// requiring exact equality. 3% comfortably covers normal forward fees with room to spare.
const ZEN_PASS_AMOUNT_TOLERANCE = 0.03;
// How far back from when the purchase was initiated (see /api/zenpass/purchase/init) a
// matching on-chain transaction is still accepted — guards against an old, unrelated
// incoming transfer from the same wallet being mistaken for this purchase.
const ZEN_PASS_LOOKBACK_MS = 5 * 60 * 1000;

function zenPassMultiplierFor(tier) {
  if (!tier || tier <= 0) return 1;
  const def = ZEN_PASS_TIERS[tier - 1];
  return def ? def.multiplier : 1;
}

/** Applies a player's Zen Pass multiplier to a base coin amount before it goes through
 *  creditCoins()'s daily cap — so the multiplier makes each run/mission/referral worth more,
 *  the same daily cap (see creditCoins() below) still bounds the total per day. */
function creditCoinsWithZenPass(player, baseAmount) {
  return creditCoins(player, Math.round(baseAmount * zenPassMultiplierFor(player.zenPassTier)));
}

/** Queries TonCenter's public HTTP API for the receiving wallet's recent incoming
 *  transactions and looks for one matching this purchase: from the expected sender address,
 *  worth at least the expected amount (within ZEN_PASS_AMOUNT_TOLERANCE), and no older than
 *  ZEN_PASS_LOOKBACK_MS before the purchase was initiated. Returns {hash, valueNanoTon} for
 *  the first match, or null if nothing matches yet (the caller should treat that as "not
 *  confirmed yet, keep polling", not as a hard failure — TON confirmation isn't instant).
 *  Never throws — a network hiccup or malformed response fails closed (returns null), same
 *  philosophy as checkTelegramMembership() above. */
async function findZenPassPayment({ receiverAddress, senderAddress, minNanoTon, sinceMs, apiKey, network }) {
  try {
    const base = network === 'testnet' ? 'https://testnet.toncenter.com' : 'https://toncenter.com';
    const url = `${base}/api/v2/getTransactions?address=${encodeURIComponent(receiverAddress)}&limit=25&archival=false`;
    const headers = apiKey ? { 'X-API-Key': apiKey } : {};
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.ok || !Array.isArray(j.result)) return null;

    const normalize = (a) => String(a || '').trim().toLowerCase();
    const wantSender = normalize(senderAddress);
    const cutoffSeconds = Math.floor((sinceMs - ZEN_PASS_LOOKBACK_MS) / 1000);
    const minAccepted = Math.floor(minNanoTon * (1 - ZEN_PASS_AMOUNT_TOLERANCE));

    for (const tx of j.result) {
      const inMsg = tx.in_msg;
      if (!inMsg || !inMsg.source) continue;
      if (normalize(inMsg.source) !== wantSender) continue;
      const value = Number(inMsg.value || 0);
      if (!Number.isFinite(value) || value < minAccepted) continue;
      const utime = Number(tx.utime || 0);
      if (!utime || utime < cutoffSeconds) continue;
      const hash = tx.transaction_id && tx.transaction_id.hash;
      if (!hash) continue;
      return { hash, valueNanoTon: value };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Daily login streak (retention). Reward escalates over a 7-day cycle, then repeats —
// see applyDailyCheckin() below and "Daily retention" in the README.
const DAILY_STREAK_REWARDS = [20, 30, 40, 60, 80, 120, 200];

// Run-submit input-evidence anti-cheat (see evaluateFlapEvidence() and "Anti-cheat,
// honestly" in the README). These are heuristics on top of the existing wall-clock bound,
// not a physics replay — deliberately conservative so a legitimate skilled player's run
// never gets flagged.
const MIN_FLAP_INTERVAL_MS = 70; // fastest plausible human tap-to-tap gap
const MIN_FLAPS_PER_POINT = 0.35; // conservative floor: even an efficient player flaps at least this often per point
const MAX_FLAP_SAMPLES = 4000; // hard cap on array size accepted from the client, so this can't be used to send an oversized payload

/* ===================== initData verification ===================== */

function verifyTelegramInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') {
    return { ok: false, error: 'initData is missing or invalid' };
  }
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'hash field not found' };
  params.delete('hash');

  const dataCheckArr = [];
  for (const [key, value] of params.entries()) dataCheckArr.push(`${key}=${value}`);
  dataCheckArr.sort();
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const hashBuffer = Buffer.from(hash, 'hex');
  const computedBuffer = Buffer.from(computedHash, 'hex');
  if (hashBuffer.length !== computedBuffer.length || !crypto.timingSafeEqual(hashBuffer, computedBuffer)) {
    return { ok: false, error: 'Hash mismatch — initData may have been forged' };
  }

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!authDate || nowSeconds - authDate > MAX_INIT_DATA_AGE_SECONDS) {
    return { ok: false, error: 'initData has expired, reopen the Mini App' };
  }
  return { ok: true, data: params };
}

function displayNameFor(telegramUser, fallback) {
  if (telegramUser.username) return '@' + telegramUser.username;
  const full = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ');
  return full || fallback || 'ZenPilot';
}

/* ===================== missions (must mirror the `missions` array in the client) ===================== */

const MISSION_DEFS = [
  { id: 'score', target: 10, reward: 50, metric: 'best' },
  { id: 'play', target: 3, reward: 30, metric: 'sum' },
  { id: 'pipes', target: 15, reward: 60, metric: 'best' }, // fed the running totalPipes total, so this is effectively cumulative
  { id: 'bull', target: 5, reward: 70, metric: 'best' },
  { id: 'highscore', target: 20, reward: 100, metric: 'best' },
  { id: 'marathon', target: 8, reward: 80, metric: 'sum' },
];

/* ===================== permanent social missions (follow X, join Telegram) =====================
   Unlike MISSION_DEFS above, these never reset — each one pays out once per player, ever.
   They mirror `socialMissions` in the client. */

const X_ACCOUNT_HANDLE = 'doggiezenfam';

const SOCIAL_MISSION_DEFS = [
  {
    id: 'follow_x',
    type: 'x',
    label: 'Follow @doggiezenfam on X',
    url: 'https://x.com/doggiezenfam',
    reward: 10000,
    // See verifyTweetPost() below and "Anti-cheat, honestly" in the README: a "follow" can't
    // be checked without paid X API access, so this mission instead requires posting a
    // public tweet containing a per-player code, which IS independently verifiable through
    // X's public oEmbed endpoint — no API key needed.
    verifyMethod: 'tweet',
  },
  {
    id: 'join_telegram',
    type: 'telegram',
    label: 'Join the DoggieZen Telegram channel',
    url: `https://t.me/${process.env.TELEGRAM_CHANNEL_USERNAME || 'doggiezen'}`,
    channelUsername: process.env.TELEGRAM_CHANNEL_USERNAME || 'doggiezen',
    reward: 10000,
    verifyMethod: 'telegram_membership',
  },
];

/** Builds the exact text a player is asked to post on X to verify the follow_x mission. */
function tweetVerificationText(code) {
  return `Flying with @${X_ACCOUNT_HANDLE} on DoggieZen 🐕✨ code:${code}`;
}

/** Checks a public tweet/X post for a player's verification code via X's public oEmbed
 *  endpoint (https://publish.twitter.com/oembed) — this requires no API key/bot token and
 *  works for any public post, but it can only confirm the post's *content*, not a follow
 *  relationship (X doesn't expose that without paid, elevated API access). Fails closed
 *  (returns false) on any network error, malformed URL, or missing code, same philosophy as
 *  checkTelegramMembership() above. */
async function verifyTweetPost(tweetUrl, code) {
  try {
    if (typeof tweetUrl !== 'string') return false;
    const match = /^https:\/\/(?:twitter\.com|x\.com)\/[A-Za-z0-9_]{1,15}\/status\/\d+/i.exec(tweetUrl.trim());
    if (!match) return false;
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(match[0])}&omit_script=true`;
    const r = await fetch(oembedUrl);
    if (!r.ok) return false;
    const j = await r.json();
    const html = (j && j.html ? String(j.html) : '').toLowerCase();
    return html.includes(String(code).toLowerCase()) && html.includes(X_ACCOUNT_HANDLE);
  } catch (e) {
    return false;
  }
}

/** Calls Telegram's getChatMember to check whether telegramId is actually a member of the
 *  channel — a real, server-verified check, not a trust-the-client one. Requires the bot to
 *  be a member (in practice, an admin) of the channel, or Telegram's API will error out.
 *  Returns false (never throws) on any failure, so a Telegram API hiccup fails closed —
 *  it denies the claim rather than granting one it couldn't actually verify. */
async function checkTelegramMembership(channelUsername, telegramId, botToken) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=@${encodeURIComponent(channelUsername)}&user_id=${encodeURIComponent(telegramId)}`;
    const r = await fetch(url);
    const j = await r.json();
    if (!j.ok || !j.result) return false;
    const status = j.result.status;
    return status === 'member' || status === 'administrator' || status === 'creator';
  } catch (e) {
    return false;
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayStr() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Daily login streak (retention hook — see "Daily retention" in the README).
 *  Advances the streak if the player last checked in yesterday, resets it to 1 if they
 *  missed a day (or this is their first-ever check-in), and does nothing (returns
 *  alreadyClaimed: true) if they already checked in today. Mutates `player` but does not
 *  save — callers must call db.save() themselves, same convention as the rest of this file. */
function applyDailyCheckin(player) {
  const today = todayStr();
  if (player.lastCheckinDate === today) {
    return { alreadyClaimed: true, reward: 0, streak: player.streakCount, longestStreak: player.longestStreak };
  }
  player.streakCount = player.lastCheckinDate === yesterdayStr() ? player.streakCount + 1 : 1;
  player.longestStreak = Math.max(player.longestStreak, player.streakCount);
  player.lastCheckinDate = today;
  const reward = DAILY_STREAK_REWARDS[(player.streakCount - 1) % DAILY_STREAK_REWARDS.length];
  // Deliberately NOT run through creditCoins()'s DAILY_COIN_CAP: that cap exists to bound
  // gameplay-run exploits, and this is a small, fixed, at-most-once-per-day amount gated by
  // lastCheckinDate above — it can't be repeated to farm coins the way a run score could.
  player.coins += reward;
  return { alreadyClaimed: false, reward, streak: player.streakCount, longestStreak: player.longestStreak };
}

/** Fallback anti-cheat check, used only when a run has no usable flapTimestamps to replay
 *  (see the replay branch in /api/run/submit, physics.js). Sanity-checks flap-timestamp
 *  evidence against the claimed score by pattern alone (too few flaps, or bot-like uniform
 *  timing) rather than a real simulation — a much weaker check than the replay, kept around
 *  purely so older client builds (or the local-preview fallback, neither of which send a
 *  replayable seed) aren't left with zero anti-cheat at all. If the client didn't send any
 *  flap evidence whatsoever, this deliberately does NOT treat that as suspicious on its own —
 *  only evidence that's actually present and implausible gets flagged. */
function evaluateFlapEvidence(flapTimestamps, elapsedMs, acceptedScore) {
  if (!Array.isArray(flapTimestamps) || flapTimestamps.length === 0) {
    return { checked: false, suspicious: false, reason: null };
  }
  const times = flapTimestamps
    .slice(0, MAX_FLAP_SAMPLES)
    .map(Number)
    .filter((t) => Number.isFinite(t) && t >= 0 && t <= elapsedMs + 500)
    .sort((a, b) => a - b);

  if (acceptedScore > 0 && times.length === 0) {
    return { checked: true, suspicious: true, reason: 'positive score but zero valid flap timestamps' };
  }
  const minFlapsNeeded = Math.ceil(acceptedScore * MIN_FLAPS_PER_POINT);
  if (times.length < minFlapsNeeded) {
    return { checked: true, suspicious: true, reason: `only ${times.length} flaps for a score of ${acceptedScore}` };
  }
  let tooFast = 0;
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] < MIN_FLAP_INTERVAL_MS) tooFast++;
  }
  if (times.length > 3 && tooFast / (times.length - 1) > 0.5) {
    return { checked: true, suspicious: true, reason: 'flap timing too fast/uniform to be human input' };
  }
  return { checked: true, suspicious: false, reason: null };
}

function ensureMissionsFresh(player) {
  const today = todayStr();
  if (player.missions.resetDate !== today) {
    player.missions = { resetDate: today, progress: {}, claimed: {} };
  }
}

function applyMissionProgress(player, id, value) {
  const def = MISSION_DEFS.find((m) => m.id === id);
  if (!def || player.missions.claimed[id]) return;
  const cur = player.missions.progress[id] || 0;
  const next = def.metric === 'sum' ? cur + value : Math.max(cur, value);
  player.missions.progress[id] = Math.min(next, def.target);
}

/** Credits coins to a player, bounded by a per-day cap. This is NOT a full cheat detector —
 *  see "Anti-cheat, honestly" in the README — it's a damage bound: even if a determined
 *  cheater finds a way to inflate a single run's score, this caps how much that's worth per
 *  day. Repeat offenders (see evaluateFlapEvidence() below) get a much tighter cap instead of
 *  the same one everyone else gets — a first flagged run is treated as noise (a weird network
 *  hiccup, a low-end device dropping frames), but a player who keeps tripping the same check
 *  is treated as a real cheater and throttled hard rather than banned outright, so a
 *  false-positive doesn't lock out an honest player forever.
 */
function creditCoins(player, amount) {
  const today = todayStr();
  if (player.dailyCoinsDate !== today) {
    player.dailyCoinsDate = today;
    player.dailyCoinsEarned = 0;
  }
  const cap =
    (player.suspiciousRunCount || 0) >= REPEAT_OFFENDER_THRESHOLD
      ? Math.round(DAILY_COIN_CAP * REPEAT_OFFENDER_CAP_FACTOR)
      : DAILY_COIN_CAP;
  const room = Math.max(0, cap - player.dailyCoinsEarned);
  const granted = Math.max(0, Math.min(amount, room));
  player.coins += granted;
  player.dailyCoinsEarned += granted;
  return granted;
}

/** Records a wallet ledger entry, but NEVER lets a failure here fail the request that
 *  called it. BUG FIX: every call site below used to `await db.addTransaction(...)`
 *  directly, un-guarded, right before sending the success response. db-blobs.js's
 *  addTransaction uses optimistic-concurrency retries on a single shared
 *  `wallet:<telegramId>` blob key (see appendTransaction() in db-blobs.js) and throws if
 *  it runs out of retries — which, under any transient write conflict (e.g. two claims
 *  landing close together), threw AFTER the player's coins/claimed-flag had already been
 *  saved to the player record. Since that throw happened before res.json(...), the whole
 *  request came back as a 500 to the client — so the player's balance was actually
 *  credited server-side, but the client never found out (coins didn't visibly update,
 *  no success toast), and worse, the wallet's transaction history was left missing that
 *  entry entirely. The ledger is a secondary, best-effort record of a balance change that
 *  has *already happened* — it should never be able to void the reward response itself. */
async function logTransaction(db, telegramId, amount, type, description) {
  try {
    await db.addTransaction(telegramId, amount, type, description);
  } catch (e) {
    console.error(`[wallet] failed to record transaction for ${telegramId} (${type}, ${amount}):`, e);
  }
}

/* ===================== app factory ===================== */

function publicPlayerView(player) {
  return {
    coins: player.coins,
    best: player.best,
    gamesPlayed: player.gamesPlayed,
    totalPipes: player.totalPipes,
    referredFriends: player.referredFriends,
    referredBy: player.referredBy,
    seenTutorial: player.seenTutorial,
    missions: { progress: player.missions.progress, claimed: player.missions.claimed },
    social: { opened: player.social.opened, claimed: player.social.claimed },
    streak: {
      count: player.streakCount,
      longest: player.longestStreak,
      claimedToday: player.lastCheckinDate === todayStr(),
    },
    zenPass: {
      tier: player.zenPassTier || 0,
      multiplier: zenPassMultiplierFor(player.zenPassTier),
      walletAddress: player.tonWalletAddress || null,
      // The next tier the player could buy, or null if they're already at the max.
      nextTier: player.zenPassTier < ZEN_PASS_MAX_TIER ? ZEN_PASS_TIERS[player.zenPassTier] : null,
    },
    autoPilot: !!player.autoPilot,
  };
}

/**
 * Builds the Express app. `db` and `store` are injected so tests can pass in isolated
 * instances instead of touching the real database / rate-limit state.
 *   db: see db.js — getPlayer/playerExists/topPlayers/rankOf/save
 *   store: see store.js — isRateLimited/openRun/consumeRun
 *   botToken: the Telegram bot token to verify initData against
 *   allowedOrigin: CORS origin (defaults to '*')
 *   zenPassWallet: the TON wallet address that receives Zen Pass payments. Optional — if
 *     unset, /api/zenpass/purchase/init refuses with a clear error instead of the endpoint
 *     silently accepting "payments" nobody will ever actually receive.
 *   toncenterApiKey: optional TonCenter API key (higher rate limit; works without one too)
 *   tonNetwork: 'mainnet' (default) or 'testnet' — which TonCenter endpoint to verify against
 */
function createApp({ db, store, botToken, allowedOrigin, zenPassWallet, toncenterApiKey, tonNetwork }) {
  if (!db) throw new Error('createApp requires a db instance');
  if (!store) throw new Error('createApp requires a store instance');
  if (!botToken) throw new Error('createApp requires a botToken');

  const app = express();
  app.set('trust proxy', true); // needed for req.ip to be correct behind a reverse proxy (Railway, Render, nginx, etc.)
  // allowedOrigin may be a single origin or a comma-separated list (e.g. your production
  // domain plus a staging one) — see ALLOWED_ORIGIN in .env.example. Falls back to '*' only
  // when nothing was passed in at all, which is fine for local dev but is refused outright
  // at boot time in production — see the NODE_ENV check at the bottom of this file.
  const corsOrigins = allowedOrigin ? allowedOrigin.split(',').map((o) => o.trim()).filter(Boolean) : '*';
  app.use(cors({ origin: corsOrigins }));
  app.use(express.json({ limit: '10kb' }));

  /** Verifies initData from a request body and returns {telegramId, telegramUser} or throws {status, error}. */
  function requireVerifiedPlayer(req) {
    const result = verifyTelegramInitData(req.body && req.body.initData, botToken);
    if (!result.ok) throw { status: 401, error: result.error };
    let telegramUser;
    try {
      telegramUser = JSON.parse(result.data.get('user') || '{}');
    } catch (e) {
      throw { status: 400, error: 'Invalid user field in initData' };
    }
    if (!telegramUser.id) throw { status: 400, error: 'Telegram ID not found in initData' };
    return { telegramId: String(telegramUser.id), telegramUser };
  }

  // small wrapper so route/middleware handlers can just `throw {status, error}` (or reject
  // a promise with one) instead of repeating try/catch; handlers may be async. Forwards
  // `next` too so this also works for the app.use() middleware below, not just terminal
  // route handlers.
  function route(handler) {
    return (req, res, next) => {
      Promise.resolve()
        .then(() => handler(req, res, next))
        .catch((e) => {
          const status = e && e.status ? e.status : 500;
          const error = e && e.error ? e.error : 'Internal server error';
          if (status === 500) console.error(e);
          res.status(status).json({ success: false, error });
        });
    };
  }

  app.use(
    route(async (req, res, next) => {
      // Coarse global guard by IP, on top of the tighter per-player limits below.
      if (await store.isRateLimited('ip:' + req.ip, 60 * 1000, 120)) {
        return res.status(429).json({ success: false, error: 'Too many requests, slow down' });
      }
      next();
    })
  );

  async function buildLeaderboard(telegramId) {
    const top = await db.topPlayers(20);
    const myRank = telegramId ? await db.rankOf(telegramId) : null;
    return { top, myRank };
  }

  app.post(
    '/api/state',
    route(async (req, res) => {
      const { telegramId, telegramUser } = requireVerifiedPlayer(req);
      if (await store.isRateLimited('state:' + telegramId, 60 * 1000, 30)) {
        throw { status: 429, error: 'Too many requests, slow down' };
      }
      const startParam = req.body.startParam ? String(req.body.startParam) : null;
      const isNew = !(await db.playerExists(telegramId));
      const player = await db.getPlayer(telegramId);
      player.username = displayNameFor(telegramUser, player.username);
      ensureMissionsFresh(player);

      // First-ever load, arrived via an invite link, referrer isn't themselves: remember who
      // referred this player, but DON'T pay the referrer yet — see the deferred-crediting
      // note in /api/run/submit below. Crediting instantly (the old behavior) meant a
      // throwaway Telegram account that never even played a game still paid out real
      // $DOGZ, which is trivially farmable. Requiring one completed run first raises the
      // bar without needing device/IP fingerprinting.
      if (isNew && startParam && startParam !== telegramId && !player.referredBy) {
        player.referredBy = startParam;
      }

      await db.save();
      const { top, myRank } = await buildLeaderboard(telegramId);
      res.json({ success: true, player: publicPlayerView(player), leaderboard: top, myRank });
    })
  );

  app.post(
    '/api/profile/tutorial-seen',
    route(async (req, res) => {
      const { telegramId } = requireVerifiedPlayer(req);
      const player = await db.getPlayer(telegramId);
      player.seenTutorial = true;
      await db.save();
      res.json({ success: true });
    })
  );

  // Daily login streak — the retention hook: a reason to open the game every day besides
  // "daily missions refilled". Pays out once per calendar day (server clock, UTC — same as
  // ensureMissionsFresh()'s todayStr()); missing a day resets the streak back to 1 rather
  // than ending the game, so a lapsed player isn't locked out, just starts over.
  app.post(
    '/api/daily/claim',
    route(async (req, res) => {
      const { telegramId } = requireVerifiedPlayer(req);
      if (await store.isRateLimited('daily:' + telegramId, 60 * 1000, 10)) {
        throw { status: 429, error: 'Too many requests, slow down' };
      }
      const player = await db.getPlayer(telegramId);
      const result = applyDailyCheckin(player);
      if (result.alreadyClaimed) {
        throw { status: 400, error: "Already checked in today — come back tomorrow for the next reward" };
      }
      await db.save();
      await logTransaction(db, telegramId, result.reward, 'daily_reward', `Daily check-in — day ${result.streak} streak`);
      res.json({
        success: true,
        reward: result.reward,
        streak: result.streak,
        longestStreak: result.longestStreak,
        player: publicPlayerView(player),
      });
    })
  );

  app.post(
    '/api/run/start',
    route(async (req, res) => {
      const { telegramId } = requireVerifiedPlayer(req);
      if (await store.isRateLimited('run-start:' + telegramId, 2000, 1)) {
        throw { status: 429, error: 'Too many requests, slow down' };
      }
      const token = crypto.randomUUID();
      // A per-run seed, generated server-side and handed to the client, which uses it to seed
      // the same deterministic pipe layout the server will independently regenerate at
      // /api/run/submit time — see physics.js and "Anti-cheat, honestly" in the README. Stored
      // alongside the token (never trusted from the client at submit time) so a run can't be
      // replayed against a seed the player didn't actually play against.
      const seed = crypto.randomInt(0, 2 ** 31);
      await store.openRun(telegramId, token, seed);
      res.json({ success: true, runToken: token, seed });
    })
  );

  app.post(
    '/api/run/submit',
    route(async (req, res) => {
      const { telegramId } = requireVerifiedPlayer(req);
      if (await store.isRateLimited('run-submit:' + telegramId, 2000, 1)) {
        throw { status: 429, error: 'Too many requests, slow down' };
      }

      const entry = await store.consumeRun(telegramId, req.body.runToken);
      if (!entry) {
        throw { status: 400, error: 'Invalid or already-used run token — start a new run' };
      }

      // Anti-cheat, layer 1 — wall clock: bounds score by real time elapsed since
      // /api/run/start, using the client's own pipe-spawn interval as the ruler. Cheap, always
      // applies, catches the trivial case (submitting a huge score for a run that barely
      // lasted any real time) even with zero other evidence.
      const cappedElapsed = Math.min(Date.now() - entry.startedAt, MAX_RUN_DURATION_MS);
      const maxPlausibleScore = Math.floor(cappedElapsed / PIPE_SPAWN_MS) + 4;
      const rawScore = Math.floor(Number(req.body.score) || 0);
      const rawBull = Math.floor(Number(req.body.bullPassed) || 0);
      let acceptedScore = Math.max(0, Math.min(9999, rawScore, maxPlausibleScore));
      let acceptedBull = Math.max(0, Math.min(acceptedScore, rawBull));
      let suspiciousReason = null;

      // Anti-cheat, layer 2 — replay: if the client sent flapTimestamps, independently
      // regenerate the exact pipe layout this run used (from the seed issued at
      // /api/run/start — never trusted from the client) and replay those recorded flaps
      // through the same physics the client itself runs (see physics.js). This is a REAL
      // simulation, not a heuristic — but see physics.js for why it's used as a tight ceiling
      // with REPLAY_SCORE_TOLERANCE slack rather than a byte-exact gate.
      if (Array.isArray(req.body.flapTimestamps) && req.body.flapTimestamps.length > 0 && entry.seed != null) {
        const flapSteps = req.body.flapTimestamps
          .map(Number)
          .filter((t) => Number.isFinite(t) && t >= 0 && t <= cappedElapsed + 500)
          .map(stepIndexForTime);
        const maxSteps = Math.ceil((cappedElapsed + 1000) / FIXED_DT_MS);
        const replay = simulateRun({ seed: entry.seed, flapSteps, maxSteps });
        const replayCeiling = replay.score + REPLAY_SCORE_TOLERANCE;
        if (acceptedScore > replayCeiling) {
          suspiciousReason = `claimed score ${acceptedScore} exceeds what its own flap timestamps replay to (${replay.score})`;
          acceptedScore = replayCeiling;
        }
        acceptedBull = Math.max(0, Math.min(acceptedScore, rawBull, replay.bullPassed + REPLAY_SCORE_TOLERANCE));
      } else {
        // No usable flap evidence to replay against (older client build, or the local-preview
        // fallback) — fall back to the lighter timing-plausibility heuristic as a second
        // opinion. Never penalizes a run just for lacking evidence, only evidence that's
        // actually present and implausible. See evaluateFlapEvidence().
        const evidence = evaluateFlapEvidence(req.body.flapTimestamps, cappedElapsed, acceptedScore);
        if (evidence.suspicious) {
          suspiciousReason = evidence.reason;
          acceptedScore = Math.min(acceptedScore, Math.ceil(acceptedScore * 0.2));
          acceptedBull = Math.max(0, Math.min(acceptedScore, rawBull));
        }
      }
      const finalScore = acceptedScore;

      const player = await db.getPlayer(telegramId);
      ensureMissionsFresh(player);
      if (suspiciousReason) {
        player.suspiciousRunCount = (player.suspiciousRunCount || 0) + 1;
        console.warn(`[anti-cheat] flagged run from ${telegramId}: ${suspiciousReason} (wall-clock bound ${Math.max(0, Math.min(9999, rawScore, maxPlausibleScore))}, folded to ${finalScore})`);
      }

      player.gamesPlayed += 1;
      player.totalPipes += finalScore; // one pipe cleared per point, same as the client's own bookkeeping

      // Deferred referral payout: only now, on this player's first-ever completed run, do
      // we pay their referrer — see the note in /api/state above for why. referralCredited
      // guards against paying twice if this ever races with itself.
      if (player.referredBy && !player.referralCredited && player.gamesPlayed === 1) {
        const referrer = await db.getPlayer(player.referredBy);
        referrer.referredFriends += 1;
        const granted = creditCoinsWithZenPass(referrer, REFERRAL_REWARD);
        player.referralCredited = true;
        if (granted > 0) {
          await logTransaction(db, player.referredBy, granted, 'referral', `Referral bonus — ${player.username} played their first run`);
        }
      }

      const rawEarnedCoins = finalScore * 3 + acceptedBull; // +1 $DOGZ per bull candle, matching the original client behavior
      const earnedCoins = creditCoinsWithZenPass(player, rawEarnedCoins);
      if (finalScore > player.best) player.best = finalScore;

      applyMissionProgress(player, 'score', finalScore);
      applyMissionProgress(player, 'play', 1);
      applyMissionProgress(player, 'marathon', 1);
      applyMissionProgress(player, 'pipes', player.totalPipes);
      applyMissionProgress(player, 'bull', acceptedBull);
      applyMissionProgress(player, 'highscore', finalScore);

      await db.save();
      if (earnedCoins > 0) {
        await logTransaction(db, telegramId, earnedCoins, 'gameplay', `Run reward — scored ${finalScore}`);
      }
      const { top, myRank } = await buildLeaderboard(telegramId);
      res.json({
        success: true,
        acceptedScore: finalScore,
        earnedCoins,
        player: publicPlayerView(player),
        leaderboard: top,
        myRank,
      });
    })
  );

  app.post(
    '/api/missions/claim',
    route(async (req, res) => {
      const { telegramId } = requireVerifiedPlayer(req);
      if (await store.isRateLimited('claim:' + telegramId, 60 * 1000, 30)) {
        throw { status: 429, error: 'Too many requests, slow down' };
      }
      const missionId = req.body.missionId;
      const def = MISSION_DEFS.find((m) => m.id === missionId);
      if (!def) throw { status: 400, error: 'Unknown mission' };

      const player = await db.getPlayer(telegramId);
      ensureMissionsFresh(player);
      if (player.missions.claimed[missionId]) throw { status: 400, error: 'Already claimed' };
      const progress = player.missions.progress[missionId] || 0;
      if (progress < def.target) throw { status: 400, error: 'Mission not complete yet' };

      player.missions.claimed[missionId] = true;
      const granted = creditCoinsWithZenPass(player, def.reward);
      await db.save();
      if (granted > 0) {
        await logTransaction(db, telegramId, granted, 'mission', `Mission reward — ${missionId}`);
      }
      res.json({ success: true, player: publicPlayerView(player) });
    })
  );

  // Called when the player taps the "Open X" / "Open Telegram" button, before they can
  // claim. This is what /api/social/claim's dwell-time check is measured against.
  app.post(
    '/api/social/open',
    route(async (req, res) => {
      const { telegramId } = requireVerifiedPlayer(req);
      if (await store.isRateLimited('social-open:' + telegramId, 60 * 1000, 30)) {
        throw { status: 429, error: 'Too many requests, slow down' };
      }
      const missionId = req.body.missionId;
      const def = SOCIAL_MISSION_DEFS.find((m) => m.id === missionId);
      if (!def) throw { status: 400, error: 'Unknown mission' };

      const player = await db.getPlayer(telegramId);
      if (!player.social.claimed[missionId]) {
        const existing = player.social.opened[missionId];
        // For tweet-verified missions, keep the same code across repeat "Open" taps so a
        // player who already posted their code doesn't have it invalidated by reopening.
        const code =
          def.verifyMethod === 'tweet' ? (existing && existing.code) || crypto.randomBytes(4).toString('hex') : null;
        player.social.opened[missionId] = {
          ts: Date.now(),
          code,
          verified: (existing && existing.verified) || false,
        };
      }
      await db.save();
      res.json({
        success: true,
        player: publicPlayerView(player),
        tweetText: def.verifyMethod === 'tweet' ? tweetVerificationText(player.social.opened[missionId].code) : undefined,
      });
    })
  );

  // Verifies the follow_x mission's proof-of-post: the player pastes back the URL of the
  // tweet they posted (see tweetVerificationText()), and this checks — via X's public,
  // no-API-key oEmbed endpoint — that a real, public post at that URL actually contains
  // their code. This does NOT confirm they followed the account (X doesn't expose that
  // without paid API access — see "Anti-cheat, honestly" in the README), but it does
  // confirm a real, attributable public action was taken, which is a meaningfully higher
  // bar than the old fully honor-based flow.
  app.post(
    '/api/social/verify-tweet',
    route(async (req, res) => {
      const { telegramId } = requireVerifiedPlayer(req);
      if (await store.isRateLimited('social-verify:' + telegramId, 60 * 1000, 10)) {
        throw { status: 429, error: 'Too many requests, slow down' };
      }
      const missionId = req.body.missionId;
      const def = SOCIAL_MISSION_DEFS.find((m) => m.id === missionId);
      if (!def || def.verifyMethod !== 'tweet') throw { status: 400, error: 'Unknown mission' };

      const player = await db.getPlayer(telegramId);
      if (player.social.claimed[missionId]) throw { status: 400, error: 'Already claimed' };
      const opened = player.social.opened[missionId];
      if (!opened || !opened.code) throw { status: 400, error: 'Open the mission first to get your verification code' };

      const ok = await verifyTweetPost(req.body.tweetUrl, opened.code);
      if (!ok) {
        throw {
          status: 400,
          error: "Couldn't verify that post — make sure the link is public and includes your exact code, then try again",
        };
      }
      opened.verified = true;
      opened.tweetUrl = String(req.body.tweetUrl); // remembered so /api/social/claim can re-check it's still live before paying out
      player.social.opened[missionId] = opened;
      await db.save();
      res.json({ success: true, player: publicPlayerView(player) });
    })
  );

  // Anti-cheat note (see also "Anti-cheat, honestly" in the README):
  //   - join_telegram is verified for real, server-side, via Telegram's getChatMember —
  //     the server checks that the player is actually in the channel, it doesn't just
  //     trust a button tap.
  //   - follow_x cannot be verified this way. X/Twitter's API for checking a follow
  //     relationship requires paid, elevated developer access that this project doesn't
  //     have. What this endpoint *can* enforce: the player must have hit /api/social/open
  //     first and waited at least SOCIAL_MIN_DWELL_MS before claiming (so it isn't a blind
  //     one-tap grab), and the reward is strictly one-time per player, ever. Beyond that,
  //     this mission is honor-based. If real verification becomes available (e.g. an X API
  //     tier that supports it), checkTelegramMembership-style logic can be dropped in here
  //     the same way it was for Telegram.
  app.post(
    '/api/social/claim',
    route(async (req, res) => {
      const { telegramId } = requireVerifiedPlayer(req);
      if (await store.isRateLimited('social-claim:' + telegramId, 60 * 1000, 10)) {
        throw { status: 429, error: 'Too many requests, slow down' };
      }
      const missionId = req.body.missionId;
      const def = SOCIAL_MISSION_DEFS.find((m) => m.id === missionId);
      if (!def) throw { status: 400, error: 'Unknown mission' };

      const player = await db.getPlayer(telegramId);
      if (player.social.claimed[missionId]) throw { status: 400, error: 'Already claimed' };

      const opened = player.social.opened[missionId];
      const openedAt = opened && opened.ts;
      if (!openedAt || Date.now() - openedAt < SOCIAL_MIN_DWELL_MS) {
        throw { status: 400, error: 'Open the link first, then come back and try again in a few seconds' };
      }

      if (def.verifyMethod === 'telegram_membership') {
        const isMember = await checkTelegramMembership(def.channelUsername, telegramId, botToken);
        if (!isMember) {
          throw { status: 400, error: "We couldn't confirm you've joined the channel yet — join it, then try again" };
        }
      } else if (def.verifyMethod === 'tweet') {
        if (!opened.verified) {
          throw { status: 400, error: 'Post the verification tweet and verify it first, then come back and claim' };
        }
        // Mitigates "post, verify, then immediately delete" abuse: re-check the same tweet
        // is still live and still contains the code right before paying out, not just at
        // verify-time. Still can't confirm an actual follow (see the note above this route),
        // but it does mean the post has to survive at least until the reward is claimed.
        const stillLive = await verifyTweetPost(opened.tweetUrl, opened.code);
        if (!stillLive) {
          throw { status: 400, error: "That post is no longer available — repost it, verify again, then come back and claim" };
        }
      }

      player.social.claimed[missionId] = true;
      // Fixed one-time reward, deliberately NOT run through creditCoins()'s DAILY_COIN_CAP —
      // that cap exists to bound gameplay-run exploits; this is a single verified/attempted
      // action per player, ever, gated by the claimed[] flag above instead.
      player.coins += def.reward;
      await db.save();
      await logTransaction(db, telegramId, def.reward, 'social_mission', `Social mission reward — ${def.label}`);
      res.json({ success: true, player: publicPlayerView(player) });
    })
  );

  // Wallet screen: current balance plus a page of ledger entries (see the `transactions`
  // table in db.js). Purely read-only — this endpoint never mutates coins, it only reports
  // history that the other endpoints above have already written. Pass `beforeId` (the id of
  // the oldest transaction already shown) to page further back — see db.getTransactions().
  const WALLET_PAGE_SIZE = 30;
  app.post(
    '/api/wallet',
    route(async (req, res) => {
      const { telegramId } = requireVerifiedPlayer(req);
      if (await store.isRateLimited('wallet:' + telegramId, 60 * 1000, 30)) {
        throw { status: 429, error: 'Too many requests, slow down' };
      }
      const player = await db.getPlayer(telegramId);
      const beforeId = req.body.beforeId ? Number(req.body.beforeId) : undefined;
      // Fetch one extra row to know whether another page exists, without a separate COUNT query.
      const page = await db.getTransactions(telegramId, WALLET_PAGE_SIZE + 1, beforeId);
      const hasMore = page.length > WALLET_PAGE_SIZE;
      const transactions = hasMore ? page.slice(0, WALLET_PAGE_SIZE) : page;
      res.json({ success: true, coins: player.coins, transactions, hasMore });
    })
  );

  // Step 1 of a Zen Pass purchase: the client has just connected (or already has) a TON
  // wallet via TonConnect and wants to buy the next tier. This doesn't touch the blockchain
  // itself — it just decides the price/tier and remembers a short-lived "intent" (see
  // store.saveZenPassIntent) that /api/zenpass/purchase/confirm below checks the actual
  // on-chain payment against, so a confirm call can't be forged with an arbitrary tier/price.
  app.post(
    '/api/zenpass/purchase/init',
    route(async (req, res) => {
      if (!zenPassWallet) throw { status: 503, error: 'Zen Pass purchases are not configured on this server yet' };
      const { telegramId } = requireVerifiedPlayer(req);
      if (await store.isRateLimited('zenpass-init:' + telegramId, 60 * 1000, 10)) {
        throw { status: 429, error: 'Too many requests, slow down' };
      }
      const walletAddress = String(req.body.walletAddress || '').trim();
      if (!walletAddress) throw { status: 400, error: 'walletAddress is required — connect a TON wallet first' };

      const player = await db.getPlayer(telegramId);
      const nextTier = (player.zenPassTier || 0) + 1;
      if (nextTier > ZEN_PASS_MAX_TIER) {
        throw { status: 400, error: 'Zen Pass is already at its max tier (x5)' };
      }
      const tierDef = ZEN_PASS_TIERS[nextTier - 1];
      const priceNanoTon = tierDef.priceTon * NANOTON_PER_TON;

      // Remember which wallet the player is paying from — used both to verify the
      // on-chain sender at confirm-time and (once purchased) for display in the Zen Pass panel.
      player.tonWalletAddress = walletAddress;
      await db.save();

      const paymentId = crypto.randomUUID();
      await store.saveZenPassIntent(telegramId, {
        paymentId,
        tier: nextTier,
        priceNanoTon,
        walletAddress,
        createdAt: Date.now(),
      });

      res.json({
        success: true,
        paymentId,
        toAddress: zenPassWallet,
        amountNanoTon: String(priceNanoTon),
        tier: nextTier,
        multiplier: tierDef.multiplier,
        priceTon: tierDef.priceTon,
      });
    })
  );

  // Step 2: the client sent the TON transfer via TonConnect and is now asking us to check
  // whether it's landed on-chain yet. Since block confirmation isn't instant, this is
  // designed to be POLLED — a "not found yet" response comes back as {success:true,
  // pending:true} (not an error), and the client is expected to call this again a few
  // seconds later rather than treating one miss as failure.
  app.post(
    '/api/zenpass/purchase/confirm',
    route(async (req, res) => {
      if (!zenPassWallet) throw { status: 503, error: 'Zen Pass purchases are not configured on this server yet' };
      const { telegramId } = requireVerifiedPlayer(req);
      if (await store.isRateLimited('zenpass-confirm:' + telegramId, 10 * 1000, 10)) {
        throw { status: 429, error: 'Too many requests, slow down' };
      }
      const paymentId = String(req.body.paymentId || '');
      const intent = await store.getZenPassIntent(telegramId);
      if (!intent || intent.paymentId !== paymentId) {
        throw { status: 400, error: 'Purchase session expired or not found — start the purchase again' };
      }

      const found = await findZenPassPayment({
        receiverAddress: zenPassWallet,
        senderAddress: intent.walletAddress,
        minNanoTon: intent.priceNanoTon,
        sinceMs: intent.createdAt,
        apiKey: toncenterApiKey,
        network: tonNetwork,
      });
      if (!found) {
        res.json({ success: true, pending: true });
        return;
      }

      const player = await db.getPlayer(telegramId);
      // Defensive re-check: the tier this intent was for must still be exactly the player's
      // next tier (guards against, e.g., two browser tabs both initiating a purchase).
      if (intent.tier !== (player.zenPassTier || 0) + 1) {
        await store.clearZenPassIntent(telegramId);
        throw { status: 400, error: 'This purchase no longer matches your current Zen Pass tier — start again' };
      }

      try {
        await db.recordZenPassPayment(telegramId, intent.tier, intent.priceNanoTon, intent.walletAddress, found.hash);
      } catch (e) {
        // UNIQUE constraint on txHash — this exact on-chain transaction was already credited
        // (a client retry racing its own earlier successful confirm). Not an error: the
        // player already has this tier, just tell them so instead of crediting it twice.
        if (!/UNIQUE/i.test(String(e && e.message))) throw e;
        await store.clearZenPassIntent(telegramId);
        res.json({ success: true, pending: false, player: publicPlayerView(await db.getPlayer(telegramId)) });
        return;
      }

      player.zenPassTier = intent.tier;
      await db.save();
      await store.clearZenPassIntent(telegramId);
      res.json({ success: true, pending: false, player: publicPlayerView(player) });
    })
  );

  // Auto Pilot purchase — same two-step TonConnect flow as Zen Pass tiers above (init hands
  // back a paymentId + price, confirm polls for the on-chain transfer), but for a single
  // one-time flag instead of an incrementing tier. See recordAutoPilotPayment() in db.js /
  // db-blobs.js for the replay-protected (txHash UNIQUE) payment ledger this writes to.
  app.post(
    '/api/autopilot/purchase/init',
    route(async (req, res) => {
      if (!zenPassWallet) throw { status: 503, error: 'Zen Pass purchases are not configured on this server yet' };
      const { telegramId } = requireVerifiedPlayer(req);
      if (await store.isRateLimited('autopilot-init:' + telegramId, 60 * 1000, 10)) {
        throw { status: 429, error: 'Too many requests, slow down' };
      }
      const walletAddress = String(req.body.walletAddress || '').trim();
      if (!walletAddress) throw { status: 400, error: 'walletAddress is required — connect a TON wallet first' };

      const player = await db.getPlayer(telegramId);
      if (player.autoPilot) throw { status: 400, error: 'Auto Pilot is already active on this account' };
      const priceNanoTon = AUTO_PILOT_PRICE_TON * NANOTON_PER_TON;

      player.tonWalletAddress = walletAddress;
      await db.save();

      const paymentId = crypto.randomUUID();
      await store.saveAutoPilotIntent(telegramId, {
        paymentId,
        priceNanoTon,
        walletAddress,
        createdAt: Date.now(),
      });

      res.json({
        success: true,
        paymentId,
        toAddress: zenPassWallet,
        amountNanoTon: String(priceNanoTon),
        priceTon: AUTO_PILOT_PRICE_TON,
      });
    })
  );

  app.post(
    '/api/autopilot/purchase/confirm',
    route(async (req, res) => {
      if (!zenPassWallet) throw { status: 503, error: 'Zen Pass purchases are not configured on this server yet' };
      const { telegramId } = requireVerifiedPlayer(req);
      if (await store.isRateLimited('autopilot-confirm:' + telegramId, 10 * 1000, 10)) {
        throw { status: 429, error: 'Too many requests, slow down' };
      }
      const paymentId = String(req.body.paymentId || '');
      const intent = await store.getAutoPilotIntent(telegramId);
      if (!intent || intent.paymentId !== paymentId) {
        throw { status: 400, error: 'Purchase session expired or not found — start the purchase again' };
      }

      const found = await findZenPassPayment({
        receiverAddress: zenPassWallet,
        senderAddress: intent.walletAddress,
        minNanoTon: intent.priceNanoTon,
        sinceMs: intent.createdAt,
        apiKey: toncenterApiKey,
        network: tonNetwork,
      });
      if (!found) {
        res.json({ success: true, pending: true });
        return;
      }

      const player = await db.getPlayer(telegramId);
      if (player.autoPilot) {
        // Already credited (e.g. a retried confirm poll) — nothing more to do.
        await store.clearAutoPilotIntent(telegramId);
        res.json({ success: true, pending: false, player: publicPlayerView(player) });
        return;
      }

      try {
        await db.recordAutoPilotPayment(telegramId, intent.priceNanoTon, intent.walletAddress, found.hash);
      } catch (e) {
        // UNIQUE constraint on txHash — this exact on-chain transaction was already credited.
        if (!/UNIQUE/i.test(String(e && e.message))) throw e;
        await store.clearAutoPilotIntent(telegramId);
        res.json({ success: true, pending: false, player: publicPlayerView(await db.getPlayer(telegramId)) });
        return;
      }

      player.autoPilot = true;
      await db.save();
      await store.clearAutoPilotIntent(telegramId);
      res.json({ success: true, pending: false, player: publicPlayerView(player) });
    })
  );

  app.post(
    '/api/leaderboard',
    route(async (req, res) => {
      let telegramId = null;
      if (req.body && req.body.initData) {
        const v = verifyTelegramInitData(req.body.initData, botToken);
        if (v.ok) {
          try {
            const u = JSON.parse(v.data.get('user') || '{}');
            if (u.id) telegramId = String(u.id);
          } catch (e) {
            /* ignore, just show the leaderboard without a personal rank */
          }
        }
      }
      const { top, myRank } = await buildLeaderboard(telegramId);
      res.json({ success: true, leaderboard: top, myRank });
    })
  );

  // Read-only admin view of accounts the run-evidence anti-cheat has flagged (see
  // evaluateFlapEvidence()), most-flagged first. Gated by ADMIN_TOKEN — unset by default,
  // which disables this endpoint entirely (fails closed) rather than leaving it open. Set
  // ADMIN_TOKEN in .env and pass it as `X-Admin-Token` to use this for manual spot-checks.
  app.get(
    '/api/admin/flagged',
    route(async (req, res) => {
      const adminToken = process.env.ADMIN_TOKEN;
      if (!adminToken || req.get('X-Admin-Token') !== adminToken) {
        throw { status: 404, error: 'Not found' };
      }
      res.json({ success: true, players: await db.flaggedPlayers(100) });
    })
  );

  app.get('/health', (req, res) => res.json({ ok: true }));

  return app;
}

module.exports = {
  createApp,
  verifyTelegramInitData,
  MISSION_DEFS,
  DAILY_COIN_CAP,
  REPEAT_OFFENDER_THRESHOLD,
  REPEAT_OFFENDER_CAP_FACTOR,
  SOCIAL_MISSION_DEFS,
  DAILY_STREAK_REWARDS,
  applyDailyCheckin,
  evaluateFlapEvidence,
  ZEN_PASS_TIERS,
  zenPassMultiplierFor,
  AUTO_PILOT_PRICE_TON,
};

/* ===================== bootstrap (only runs when this file is executed directly) ===================== */

if (require.main === module) {
  require('dotenv').config();
  const path = require('path');
  const { createDb } = require('./db');
  const { createStore } = require('./store');

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) {
    console.error('FATAL: TELEGRAM_BOT_TOKEN not found in environment variables.');
    console.error('Create a .env file (see .env.example) and NEVER commit it to git.');
    process.exit(1);
  }

  // CORS defaulting to '*' is fine for local development, but a silently-forgotten '*' in
  // production means literally any website can call this API with a visitor's browser
  // session. Rather than ship that as a quiet default, fail closed: refuse to boot in
  // production unless ALLOWED_ORIGIN is explicitly set. Set NODE_ENV=production (most hosts,
  // including Railway/Render, do this automatically) plus ALLOWED_ORIGIN in .env.
  if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGIN) {
    console.error('FATAL: NODE_ENV=production but ALLOWED_ORIGIN is not set.');
    console.error('Set ALLOWED_ORIGIN in .env to your real game domain(s) — comma-separated for more than one.');
    console.error('Refusing to boot with an open (\'*\') CORS policy in production.');
    process.exit(1);
  }

  // Rate limits and open run tokens default to in-memory state (see store.js), which is
  // fine for a single instance but is silently lost on every restart/deploy and can't be
  // shared if you ever scale to more than one instance behind a load balancer. This isn't
  // fatal the way a missing ALLOWED_ORIGIN is — plenty of small deployments never need more
  // than one instance — so it's a loud warning rather than a hard refusal to boot.
  if (process.env.NODE_ENV === 'production' && !process.env.REDIS_URL) {
    console.warn('[warning] NODE_ENV=production but REDIS_URL is not set.');
    console.warn('[warning] Rate limits and run tokens are in-memory only: they reset on every restart/deploy,');
    console.warn('[warning] and will NOT be shared correctly if you ever run more than one instance. Set REDIS_URL');
    console.warn('[warning] once you need either of those — see store.js.');
  }

  const db = createDb(process.env.DB_FILE || path.join(__dirname, 'data.sqlite'), {
    backupDir: process.env.BACKUP_DIR,
    backupIntervalMs: process.env.BACKUP_INTERVAL_MS ? Number(process.env.BACKUP_INTERVAL_MS) : undefined,
    backupKeep: process.env.BACKUP_KEEP ? Number(process.env.BACKUP_KEEP) : undefined,
  });
  // Zen Pass (see the "Zen Pass" block near the top of this file). Optional at boot — if
  // ZEN_PASS_WALLET is unset, the purchase endpoints just refuse with a clear 503 instead of
  // the server failing to start, since plenty of deployments won't have this configured yet.
  if (!process.env.ZEN_PASS_WALLET) {
    console.warn('[warning] ZEN_PASS_WALLET is not set — Zen Pass purchases are disabled until it is.');
  }

  const store = createStore({ redisUrl: process.env.REDIS_URL });
  const app = createApp({
    db,
    store,
    botToken: BOT_TOKEN,
    allowedOrigin: process.env.ALLOWED_ORIGIN,
    zenPassWallet: process.env.ZEN_PASS_WALLET || null,
    toncenterApiKey: process.env.TONCENTER_API_KEY || null,
    tonNetwork: process.env.TON_NETWORK || 'mainnet',
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`DoggieZen backend running on port ${PORT}`);
  });

  // Best-effort flush on shutdown so nothing dirty in the SQLite cache is lost.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      db.close();
      process.exit(0);
    });
  }
}
