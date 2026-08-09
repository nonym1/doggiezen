// Standalone smoke test for the core logic in server.js (verification, missions,
// leaderboard) using only Node's built-in crypto — no express/cors install needed to run this.
const crypto = require('crypto');
const assert = require('assert');

function verifyTelegramInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') return { ok: false, error: 'initData is missing or invalid' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'hash field not found' };
  params.delete('hash');
  const arr = [];
  for (const [k, v] of params.entries()) arr.push(`${k}=${v}`);
  arr.sort();
  const dataCheckString = arr.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const hb = Buffer.from(hash, 'hex'), cb = Buffer.from(computedHash, 'hex');
  if (hb.length !== cb.length || !crypto.timingSafeEqual(hb, cb)) return { ok: false, error: 'Hash mismatch' };
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > 3600) return { ok: false, error: 'expired' };
  return { ok: true, data: params };
}

// Helper that plays the role of Telegram: builds a validly-signed initData string.
function buildSignedInitData(botToken, userObj, extra) {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(userObj));
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  if (extra) for (const k in extra) params.set(k, extra[k]);
  const arr = [];
  for (const [k, v] of params.entries()) arr.push(`${k}=${v}`);
  arr.sort();
  const dataCheckString = arr.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

const BOT_TOKEN = 'fake-token-for-testing-only';

// 1. Valid initData should verify successfully
const valid = buildSignedInitData(BOT_TOKEN, { id: 12345, first_name: 'Test', username: 'tester' });
const r1 = verifyTelegramInitData(valid, BOT_TOKEN);
assert.strictEqual(r1.ok, true, 'valid initData should pass verification');
console.log('PASS: valid initData verifies');

// 2. Tampered initData (score/user changed after signing) should fail
const tampered = valid.replace('Test', 'Hacked');
const r2 = verifyTelegramInitData(tampered, BOT_TOKEN);
assert.strictEqual(r2.ok, false, 'tampered initData should fail verification');
console.log('PASS: tampered initData is rejected');

// 3. Wrong bot token should fail
const r3 = verifyTelegramInitData(valid, 'a-different-token');
assert.strictEqual(r3.ok, false, 'wrong bot token should fail verification');
console.log('PASS: wrong bot token is rejected');

// 4. Expired auth_date should fail
const oldParams = new URLSearchParams(valid);
oldParams.set('auth_date', String(Math.floor(Date.now() / 1000) - 7200)); // 2h old
// re-sign with the old auth_date so only the *age* check fails, not the hash check
const rebuilt = buildSignedInitData(BOT_TOKEN, { id: 12345, first_name: 'Test', username: 'tester' }, { auth_date: String(Math.floor(Date.now() / 1000) - 7200) });
const r4 = verifyTelegramInitData(rebuilt, BOT_TOKEN);
assert.strictEqual(r4.ok, false, 'expired initData should fail verification');
console.log('PASS: expired initData is rejected');

/* ---- mission progress logic ---- */
const MISSION_DEFS = [
  { id: 'score', target: 10, reward: 50, metric: 'best' },
  { id: 'play', target: 3, reward: 30, metric: 'sum' },
];
function applyMissionProgress(player, id, value) {
  const def = MISSION_DEFS.find((m) => m.id === id);
  if (!def || player.missions.claimed[id]) return;
  const cur = player.missions.progress[id] || 0;
  const next = def.metric === 'sum' ? cur + value : Math.max(cur, value);
  player.missions.progress[id] = Math.min(next, def.target);
}
const p = { missions: { progress: {}, claimed: {} } };
applyMissionProgress(p, 'score', 4);
applyMissionProgress(p, 'score', 2); // lower than current best -> should NOT decrease
assert.strictEqual(p.missions.progress.score, 4, "'best' metric should keep the max, not overwrite with a lower value");
applyMissionProgress(p, 'score', 15); // above target -> should clamp to target
assert.strictEqual(p.missions.progress.score, 10, "'best' metric should clamp at target");
applyMissionProgress(p, 'play', 1);
applyMissionProgress(p, 'play', 1);
assert.strictEqual(p.missions.progress.play, 2, "'sum' metric should accumulate");
console.log('PASS: mission progress logic behaves correctly');

/* ---- leaderboard ranking ---- */
function buildLeaderboard(players, telegramId) {
  const sorted = players.filter((p) => p.gamesPlayed > 0).sort((a, b) => b.best - a.best || a.createdAt - b.createdAt);
  const top = sorted.slice(0, 20).map((p) => ({ tgId: p.telegramId, name: p.username, score: p.best }));
  let myRank = null;
  if (telegramId) {
    const idx = sorted.findIndex((p) => p.telegramId === telegramId);
    if (idx >= 0) myRank = { rank: idx + 1, score: sorted[idx].best };
  }
  return { top, myRank };
}
const players = [
  { telegramId: 'a', username: 'A', best: 30, gamesPlayed: 1, createdAt: 1 },
  { telegramId: 'b', username: 'B', best: 50, gamesPlayed: 1, createdAt: 2 },
  { telegramId: 'c', username: 'C', best: 10, gamesPlayed: 0, createdAt: 3 }, // never played -> excluded
];
const { top, myRank } = buildLeaderboard(players, 'a');
assert.strictEqual(top.length, 2, 'players with 0 games played should be excluded from the leaderboard');
assert.strictEqual(top[0].tgId, 'b', 'highest score should rank first');
assert.strictEqual(myRank.rank, 2, "caller's own rank should be computed correctly");
console.log('PASS: leaderboard sorting and own-rank lookup are correct');

/* ---- anti-cheat score bound ---- */
const MAX_RUN_DURATION_MS = 5 * 60 * 1000;
const PIPE_SPAWN_MS = 1700;
function acceptedScoreFor(elapsedMs, claimedScore) {
  const cappedElapsed = Math.min(elapsedMs, MAX_RUN_DURATION_MS);
  const maxPlausible = Math.floor(cappedElapsed / PIPE_SPAWN_MS) + 4;
  return Math.max(0, Math.min(9999, claimedScore, maxPlausible));
}
assert.strictEqual(acceptedScoreFor(3000, 9999), 5, 'a 3s run claiming score 9999 should be clamped down hard');
assert.strictEqual(acceptedScoreFor(20000, 8), 8, 'a plausible score within an 20s run should pass through unchanged');
console.log('PASS: score anti-cheat clamp behaves as expected');

/* ---- flap-timestamp evidence (anti-cheat second layer, see evaluateFlapEvidence() in
   server.js) — reimplemented standalone here the same way the other logic above is. ---- */
const MIN_FLAP_INTERVAL_MS = 70;
const MIN_FLAPS_PER_POINT = 0.35;
const MAX_FLAP_SAMPLES = 4000;
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

// No evidence sent at all (older client, or offline fallback) must never be treated as
// suspicious on its own — a rollout gap should never punish real players.
const noEvidence = evaluateFlapEvidence(undefined, 10000, 8);
assert.strictEqual(noEvidence.checked, false, 'missing flap evidence should not be checked at all');
assert.strictEqual(noEvidence.suspicious, false, 'missing flap evidence should never itself be suspicious');

// Plausible, evenly-spaced flaps supporting the claimed score should pass.
const plausibleTimes = [];
for (let t = 0; t < 8000; t += 400) plausibleTimes.push(t); // 20 flaps, well over the 0.35/point floor for a score of 8
const plausible = evaluateFlapEvidence(plausibleTimes, 8000, 8);
assert.strictEqual(plausible.checked, true, 'evidence that was actually sent should be checked');
assert.strictEqual(plausible.suspicious, false, 'plausible, human-spaced flaps should not be flagged');

// Too few flaps for the claimed score is implausible and should be flagged.
const tooFew = evaluateFlapEvidence([100], 8000, 8);
assert.strictEqual(tooFew.suspicious, true, 'far too few flaps for the claimed score should be flagged');

// Bot-like uniform, faster-than-human flap timing should be flagged even if the count is enough.
const uniformFast = [];
for (let t = 0; t < 800; t += 20) uniformFast.push(t); // 40 flaps, 20ms apart — under MIN_FLAP_INTERVAL_MS every time
const tooFast = evaluateFlapEvidence(uniformFast, 8000, 8);
assert.strictEqual(tooFast.suspicious, true, 'uniform sub-human-speed flap timing should be flagged');
console.log('PASS: flap-timestamp evidence heuristic behaves correctly');

/* ---- social mission "opened" shape: now { ts, code, verified } per player, not a bare
   timestamp — this is what changed under /api/social/open + /api/social/verify-tweet. ---- */
const socialPlayer = { social: { opened: {}, claimed: {} } };
socialPlayer.social.opened.follow_x = { ts: Date.now(), code: 'ab12cd34', verified: false };
assert.strictEqual(typeof socialPlayer.social.opened.follow_x, 'object', 'opened[missionId] should be an object, not a bare number');
assert.ok(socialPlayer.social.opened.follow_x.code, 'a tweet-verified mission should carry a verification code');
assert.strictEqual(socialPlayer.social.opened.follow_x.verified, false, 'verified should start false until /api/social/verify-tweet confirms the post');
console.log('PASS: social.opened uses the { ts, code, verified } shape');

/* ---- repeat-offender daily coin cap (mirrors creditCoins() in server.js) ---- */
const DAILY_COIN_CAP = 3000;
const REPEAT_OFFENDER_THRESHOLD = 3;
const REPEAT_OFFENDER_CAP_FACTOR = 0.2;
function creditCoins(player, amount) {
  const today = '2026-01-01'; // fixed stand-in for todayStr(), irrelevant to the logic under test
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
  player.coins = (player.coins || 0) + granted;
  player.dailyCoinsEarned += granted;
  return granted;
}
{
  const clean = { coins: 0, dailyCoinsEarned: 0, dailyCoinsDate: null, suspiciousRunCount: 0 };
  const grantedClean = creditCoins(clean, 5000);
  assert.strictEqual(grantedClean, DAILY_COIN_CAP, 'a player with no flags should get the full daily cap');

  const repeatOffender = { coins: 0, dailyCoinsEarned: 0, dailyCoinsDate: null, suspiciousRunCount: 3 };
  const grantedFlagged = creditCoins(repeatOffender, 5000);
  assert.strictEqual(
    grantedFlagged,
    Math.round(DAILY_COIN_CAP * REPEAT_OFFENDER_CAP_FACTOR),
    'a player flagged 3+ times should be capped much lower than a clean player, same day'
  );
  assert.ok(grantedFlagged < grantedClean, 'the repeat-offender cap must be strictly tighter than the normal cap');

  const almostFlagged = { coins: 0, dailyCoinsEarned: 0, dailyCoinsDate: null, suspiciousRunCount: 2 };
  const grantedAlmost = creditCoins(almostFlagged, 5000);
  assert.strictEqual(grantedAlmost, DAILY_COIN_CAP, 'the tighter cap should only kick in AT the threshold, not before it');
}
console.log('PASS: repeat-offender daily coin cap throttles flagged accounts without punishing a single flagged run');

/* ---- deferred referral crediting (mirrors /api/state + /api/run/submit in server.js):
   the referrer should NOT be paid the instant a referred player opens the app — only once
   that player finishes their first real run. This closes the "spin up a throwaway account
   and never play" farming path the old instant-credit version had. ---- */
{
  // Step 1: referred player's first /api/state load — remembers who referred them, pays nothing yet.
  const referred = { referredBy: null, referralCredited: false, gamesPlayed: 0 };
  const referrer = { coins: 0, referredFriends: 0 };
  const startParam = 'referrer-id';
  if (!referred.referredBy) referred.referredBy = startParam; // mirrors the /api/state branch
  assert.strictEqual(referrer.coins, 0, 'the referrer must not be paid just from the referred player opening the app');
  assert.strictEqual(referrer.referredFriends, 0, 'referredFriends must not increment before a real run is played');

  // Step 2: referred player finishes their first run — NOW the referrer gets paid.
  referred.gamesPlayed += 1;
  if (referred.referredBy && !referred.referralCredited && referred.gamesPlayed === 1) {
    referrer.referredFriends += 1;
    referrer.coins += 1000; // REFERRAL_REWARD in server.js
    referred.referralCredited = true;
  }
  assert.strictEqual(referrer.coins, 1000, 'the referrer should be paid once the referred player completes their first run');
  assert.strictEqual(referred.referralCredited, true, 'referralCredited should flip so a later run never pays out twice');

  // Step 3: a second run by the same (already-credited) referred player must not pay again.
  referred.gamesPlayed += 1;
  if (referred.referredBy && !referred.referralCredited && referred.gamesPlayed === 1) {
    referrer.coins += 1000; // would only run if the guard above were missing
  }
  assert.strictEqual(referrer.coins, 1000, 'a second run must not pay the referrer a second time');
}
console.log('PASS: referral reward is deferred to the referred player\'s first completed run, and only paid once');

/* ---- physics.js replay-based anti-cheat (mirrors the acceptance logic in /api/run/submit) ---- */
{
  const { simulateRun, FIXED_DT_MS, mulberry32 } = require('./physics');
  const REPLAY_SCORE_TOLERANCE = 2;
  const seed = 778899;

  // A "skilled" flap pattern generated by a tiny controller (flap whenever a free-fall
  // simulation would drift below a target altitude), rather than a fixed mechanical interval
  // — a constant-interval cadence tends to pin the dog against the ceiling or floor
  // regardless of pipe layout, which would make every seed die identically on the first pipe
  // and defeat the point of testing seed-dependent behavior below.
  const GRAVITY = 0.45, FLAP_IMPULSE = -8.4;
  function controllerFlapSteps(totalSteps, target) {
    let y = 400, vy = 0;
    const steps = [];
    for (let s = 0; s < totalSteps; s++) {
      if (y > target && vy > -2) {
        vy = FLAP_IMPULSE;
        steps.push(s);
      }
      vy += GRAVITY;
      y += vy;
    }
    return steps;
  }
  const totalSteps = Math.ceil(20000 / FIXED_DT_MS);
  const flapSteps = controllerFlapSteps(totalSteps, 400);
  assert.ok(flapSteps.length > 10, 'the controller flap pattern should produce a reasonable number of flaps');

  const replay = simulateRun({ seed, flapSteps, maxSteps: totalSteps });
  assert.ok(replay.score >= 0, 'replay should produce a non-negative score');

  // Honest case: client claims exactly what the replay says it earned -> accepted unchanged.
  const honestClaim = replay.score;
  const honestAccepted = Math.min(honestClaim, replay.score + REPLAY_SCORE_TOLERANCE);
  assert.strictEqual(honestAccepted, honestClaim, 'a claim matching its own replay must be accepted as-is');

  // Cheating case: client claims far more than the same recorded flaps actually replay to
  // (e.g. the client was tampered with to report a bigger score than it actually played) ->
  // clamped down to the replay ceiling, not trusted.
  const cheatClaim = replay.score + 500;
  const cheatAccepted = Math.min(cheatClaim, replay.score + REPLAY_SCORE_TOLERANCE);
  assert.strictEqual(cheatAccepted, replay.score + REPLAY_SCORE_TOLERANCE, 'an inflated claim must be clamped to the replay ceiling');
  assert.ok(cheatAccepted < cheatClaim, 'the clamp must actually reduce an inflated claim');

  // Determinism: replaying the exact same seed + flaps twice must agree — this is the whole
  // basis for trusting the server's independently-computed score in the first place.
  const replayAgain = simulateRun({ seed, flapSteps, maxSteps: Math.ceil(20000 / FIXED_DT_MS) });
  assert.deepStrictEqual(replay, replayAgain, 'replaying the same seed + flaps must be perfectly deterministic');

  // Different seeds produce a different pipe layout (checked directly at the RNG level,
  // rather than via emergent gameplay outcome — a fixed mechanical flap cadence can pin the
  // dog into the same ceiling-bounce trajectory regardless of seed, which would make an
  // outcome-based comparison fragile/coincidental rather than actually testing the RNG).
  const seqA = mulberry32(seed);
  const seqB = mulberry32(seed + 1);
  const drawsA = [seqA(), seqA(), seqA()];
  const drawsB = [seqB(), seqB(), seqB()];
  assert.notDeepStrictEqual(drawsA, drawsB, 'different seeds must produce different pipe-layout draws');
}
console.log('PASS: physics.js replay determinism + score-clamping logic behaves correctly');

console.log('\nAll smoke tests passed.');
