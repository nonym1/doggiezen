# DoggieZen

A candlestick-dodging flyer for Telegram Mini Apps, plus the backend that makes coins,
the leaderboard, missions, and referrals real instead of local-only.

> **Deploying to Netlify?** See `DEPLOY_NETLIFY.md` instead — frontend and backend now
> deploy together as one Netlify site (Netlify Functions + Netlify Blobs, no external
> database/Redis to sign up for). The rest of this README describes the original
> architecture (a standalone Node host + SQLite + optional Redis) — still accurate for the
> game's rules/anti-cheat/endpoints either way, since `server.js` and `physics.js` didn't
> change; only the storage layer did (`db-blobs.js`/`store-blobs.js`, see that doc).

## What's in this folder

| File | What it is |
|---|---|
| `doggiezen-2-7-1.html` | The game itself — a single static file you host anywhere (Vercel, Netlify, S3, GitHub Pages, etc.) |
| `manifest.json` | PWA manifest so the game can be "added to home screen" cleanly |
| `server.js` | The backend — builds the Express app (`createApp`) and all the endpoints below |
| `physics.js` | Deterministic gameplay simulation (gravity/flap/pipes/collision), used by `server.js` to replay a run's recorded inputs and independently check its score — see "Anti-cheat, honestly" below. The client embeds an identical inline copy, since it's deployed as a single static file with no build step |
| `db.js` | SQLite-backed data store (see "Scaling" below) |
| `store.js` | Rate-limit + run-token state — in-memory by default, optionally Redis (see "Rate limiting" below) |
| `test-logic.js` | A dependency-free smoke test for the backend's core logic |
| `test-integration.js` | Integration tests that hit the real Express app over HTTP (needs `npm install` first) |
| `package.json`, `.env.example` | Backend dependencies and config |
| `.github/workflows/ci.yml` | GitHub Actions workflow that runs `npm test` on every push/PR (see "Testing" below) |

## Before you start

1. **Revoke the old bot token** in @BotFather → `/mybots` → `@doggiezenbot` → API Token →
   *Revoke current token*. Treat any token that's ever been pasted into a chat as burned.
2. Copy the **new** token BotFather gives you.

## Backend setup

```bash
npm install
cp .env.example .env
```
Open `.env` and set `TELEGRAM_BOT_TOKEN` to the new token. Optionally set `ALLOWED_ORIGIN`
to the exact domain the game will be hosted on (defaults to `*`, i.e. any origin — fine for
testing, not for production).

```bash
npm test    # runs test-logic.js, then test-integration.js against a real in-memory app
npm start   # starts the backend on PORT (default 3000)
```

`better-sqlite3` compiles a small native module during `npm install`. Most platforms get a
prebuilt binary automatically; on an unusual platform you may need build tools installed
(`python3`, a C++ compiler) — if `npm install` fails on it, that's the usual reason.

Deploy `server.js` + `db.js` + `store.js` + `package.json` + `.env` to any Node host
(Railway, Render, a small VPS, etc.) — anywhere that isn't the same static hosting as the
HTML file. The SQLite file (`data.sqlite`) lives on that host's disk, so use a host with a
persistent disk (not a purely ephemeral filesystem) or point `DB_FILE` at a mounted volume.

## Client setup

In `doggiezen-2-7-1.html`, find this near the top of the `<script>` block:

```js
const API_BASE_URL = 'https://your-server.com';
```

Point it at wherever you deployed the backend. Also still needed, further up in the same
file:

```js
const TELEGRAM_APP_SHORT_NAME = 'doggiezen'; // confirm this matches BotFather's Mini App short name
```

`TELEGRAM_BOT_USERNAME` is already filled in as `'doggiezenbot'`.

`icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, and `og-preview.png` (1200x630)
now ship in this folder and are already wired up in `manifest.json` and `<head>` — nothing
to add there. The one thing still left: once the game has a real domain, replace the
placeholder `og:url` / `og:image` / `twitter:image` values in `<head>` with that domain,
since social-share scrapers need an absolute URL and won't resolve a relative path.

## How the game and backend fit together

- **Inside Telegram** (`tg.initData` present): every meaningful action — loading your
  stats, starting a run, ending a run, claiming a mission, checking the leaderboard —
  goes through the backend, which verifies `initData`'s signature before touching anything.
  The client never decides its own coin balance; it only displays what the server returns.
- **Opened as a plain webpage** (no Telegram, e.g. testing locally): there's no `initData`
  to verify, so the game falls back to browser-local storage (`window.storage`, the Claude
  Artifact preview storage) so you can still click around and test the UI. Nothing in that
  mode is shared with real players or trustworthy — it's a preview fallback, not a second
  real backend.

## Endpoints

All endpoints are `POST` with a JSON body containing `initData` (Telegram's raw signed
string) unless noted otherwise.

- `POST /api/state` `{initData, startParam}` — loads or creates the player, syncs their
  Telegram display name, applies a pending referral on first-ever load, returns their full
  state + the leaderboard.
- `POST /api/run/start` `{initData}` — opens a run, returns a one-time `runToken` **and a
  `seed`**. The client uses the seed to generate this run's pipe layout (via the same
  deterministic PRNG as `physics.js`) instead of `Math.random()`, so the server can
  regenerate the identical layout later — see "Anti-cheat, honestly" below.
- `POST /api/run/submit` `{initData, runToken, score, bullPassed, flapTimestamps}` — closes
  the run. First bounded against how much wall-clock time actually passed since
  `/api/run/start`; then, if the client sent `flapTimestamps` (ms-since-run-start of every
  flap), the server **replays** those flaps through `physics.js` using the seed it issued for
  this run and checks the claimed score against what that replay actually produced. Coins,
  best score, and mission progress are only updated with whatever score survives both
  checks. See "Anti-cheat, honestly" below for exactly what this does and doesn't guarantee.
- `POST /api/missions/claim` `{initData, missionId}` — pays out a daily mission reward if
  it's actually complete and not already claimed.
- `POST /api/daily/claim` `{initData}` — pays out today's daily login streak reward (once
  per calendar day, server clock). See "Daily retention" below.
- `POST /api/social/open` `{initData, missionId}` — call when the player taps "Open" on a
  permanent social mission (follow X / join Telegram), before they can claim it. For the
  X mission this also returns `tweetText`: the exact text (with a per-player verification
  code baked in) the client should show the player to post.
- `POST /api/social/verify-tweet` `{initData, missionId, tweetUrl}` — for the follow-X
  mission only: checks that `tweetUrl` is a real, public post containing the player's code,
  via X's public oEmbed endpoint. Must succeed before `/api/social/claim` will pay out for
  `follow_x`. See "Anti-cheat, honestly" below for exactly what this does and doesn't prove.
- `POST /api/social/claim` `{initData, missionId}` — pays out a permanent, one-time-ever
  social mission (10,000 $DOGZ each for following @doggiezenfam on X and joining the
  Telegram channel). Requires `/api/social/open` to have been called first and a short
  delay to have passed; the Telegram mission also verifies real channel membership
  server-side, and the X mission also requires a successful `/api/social/verify-tweet` call
  first. See "Anti-cheat, honestly" below for both missions' limits.
- `POST /api/leaderboard` `{initData}` — top 20 + the caller's own rank (initData is
  optional here; without it you just get the top 20 with no personal rank).
- `POST /api/wallet` `{initData, beforeId?}` — current $DOGZ balance plus a page (30) of the
  player's transaction ledger, newest first. Pass `beforeId` (the `id` of the oldest
  transaction already loaded) to page further back; the response's `hasMore` says whether
  another page exists. Purely read-only — every credit is actually logged by the endpoint
  that granted it (`/api/run/submit`, `/api/missions/claim`, `/api/daily/claim`,
  `/api/social/claim`, and the referral payout inside `/api/run/submit`), this just reads
  that ledger back.
- `POST /api/profile/tutorial-seen` `{initData}` — marks the intro tutorial dismissed.
- `POST /api/zenpass/purchase/init` `{initData, walletAddress}` — step 1 of buying the next
  Zen Pass tier: server decides the price and returns a `paymentId` + the receiving address
  and amount to send. See "Zen Pass" below.
- `POST /api/zenpass/purchase/confirm` `{initData, paymentId}` — step 2: checks whether the
  on-chain payment for that `paymentId` has landed yet. Meant to be **polled** — a miss comes
  back as `{success:true, pending:true}`, not an error.
- `GET /api/admin/flagged` — read-only list of accounts the anti-cheat evidence check has
  flagged, most-flagged first. Not part of the game's normal flow — see "Admin" below.

## Zen Pass

A paid coin multiplier, bought with real TON. Tier 1 (x2 coins) costs 1 TON; each further
purchase advances one tier at a time, up to tier 4 (x5 coins) for 4 TON total across all four
purchases (1 + 2 + 3 + 4). The multiplier applies to gameplay run rewards, `/api/missions/claim`
rewards, and the referral bonus — deliberately not the daily login streak or the one-time
social-mission payout, since those weren't part of the original ask. See
`ZEN_PASS_TIERS`/`creditCoinsWithZenPass` in `server.js` if you want to extend that.

**Setup, before this works for real players:**

1. Get a TON wallet to receive payments into, and set `ZEN_PASS_WALLET` in `.env` to its
   address.
2. (Recommended) Get a free API key from https://toncenter.com/ and set
   `TONCENTER_API_KEY` — payment confirmation works without one, just at a lower rate limit.
3. Host `tonconnect-manifest.json` (included in this folder) somewhere public over HTTPS, and
   point `TONCONNECT_MANIFEST_URL` near the top of `doggiezen-2-7-1.html`'s `<script>` at its
   real URL. Fill in the manifest's own `url`/`iconUrl` fields too. TonConnect wallets fetch
   this to show your app's name/icon on the connect screen — it can't be relative or
   localhost.
4. **Test on testnet first.** Set `TON_NETWORK=testnet` in `.env`, use a testnet wallet
   (e.g. Tonkeeper's testnet mode) and testnet TON from a faucet, and walk through a full
   purchase before ever pointing this at mainnet money. I built this against TonConnect UI
   and TonCenter's documented APIs but couldn't run a live end-to-end test in the environment
   I built it in — treat the payment path as needing your own verification before going live.
5. Payment verification works by matching, on the receiving wallet's recent transactions: the
   sender address (the wallet the player connected), an amount within 3% of the expected
   price (a small forward fee is normal), and a timestamp after the purchase was initiated.
   Each on-chain transaction can only ever be credited once (`txHash` is `UNIQUE` in
   `zen_pass_payments` — see `db.js`).

## Anti-cheat, honestly

`/api/run/submit` bounds the score in two layers, plus a damage-bound cap underneath both.

**Layer 1 — wall clock.** The server knows when `/api/run/start` was called, and clamps the
submitted score to roughly what's achievable in that many real seconds given the game's
pipe-spawn rate. Cheap, always applies, catches the trivial exploit (opening dev tools and
submitting a made-up score of 9999) with zero simulation needed.

**Layer 2 — server-side physics replay.** `physics.js` is a small, dependency-free,
deterministic reimplementation of the game's gravity/flap/pipe/collision logic — same
gravity, flap impulse, pipe gap/width, speed ramp, and spawn cadence as the client, stepped
at a fixed 60 steps/second instead of once per raw `requestAnimationFrame` call (that fix
also resolved a real bug: before this, the game ran genuinely faster on a 120Hz phone than a
60Hz one, since `update()` used to run once per frame with no time scaling at all).

At `/api/run/start`, the server generates a random `seed` and hands it to the client — which
uses it (via `mulberry32()`, a small seeded PRNG, also in `physics.js`) to generate this
run's pipe layout instead of `Math.random()`. The client already sends `flapTimestamps`
(ms-since-run-start of every flap) with `/api/run/submit`; the server now converts those to
fixed-step indices and calls `simulateRun({ seed, flapSteps })` — which regenerates the
*exact same* pipe layout the player actually saw, and replays their actual recorded flaps
through it. That produces an independently-computed score, which the claimed score is
checked against (`REPLAY_SCORE_TOLERANCE` in `server.js`, currently 2 points of slack). A
claim beyond that ceiling gets clamped down to it and the account's `suspiciousRunCount` is
incremented (visible via `GET /api/admin/flagged`, see "Admin" below).

This is a genuine simulation, not a heuristic — but it's still not byte-perfect, and
deliberately isn't treated as one. The client runs on real device timing
(`requestAnimationFrame`), so exactly which fixed step a flap "belongs to" right at a frame
boundary can differ by one between what the client actually did and what the server's replay
assumes from the timestamp alone — the server has no way to observe sub-frame timing, only
the reported time. `REPLAY_SCORE_TOLERANCE` exists purely to absorb that ambiguity: it's
small enough to be useless for meaningfully inflating a score, but large enough that an
honest player is never flagged over which side of a frame boundary a tap landed on. See the
comments at the top of `physics.js` for more detail on this tradeoff.

If a run sends no `flapTimestamps` at all (an older client build, or the local-preview
fallback that never talks to `/api/run/start`), there's no seed-backed replay to check
against, so the server falls back to the lighter pattern-based heuristic that used to be the
only check (`evaluateFlapEvidence()` in `server.js`: too few flaps for the claimed score, or
flap timing too fast/uniform to be human). This is intentionally the *weaker* fallback path,
not the primary check anymore — kept only so a run with no evidence isn't left with zero
anti-cheat, without ever penalizing a run just for lacking evidence it was never in a
position to send.

**Underneath both layers,** every player also has a `DAILY_COIN_CAP` (3000 $DOGZ/day, in
`server.js`). This doesn't catch a cheater — it bounds the damage: even in the (now much
narrower) worst case where someone does get a score past both checks above, there's a hard
ceiling on how many coins that's worth per day, so it can't be repeated into an unbounded
exploit.

**Repeat offenders get throttled harder.** A single flagged run is treated as noise (a flaky
network, a low-end device dropping frames, or the frame-boundary ambiguity above) and just
uses the normal `DAILY_COIN_CAP`. But once a player's `suspiciousRunCount` reaches `REPEAT_OFFENDER_THRESHOLD` (3), their daily cap
drops to `DAILY_COIN_CAP * REPEAT_OFFENDER_CAP_FACTOR` (20%, ~600 $DOGZ/day) from then on —
see `creditCoins()` in `server.js`. This is still a damage bound, not a ban: a false-positive
doesn't lock an honest player out, it just means a genuine repeat cheater's upside keeps
shrinking instead of staying flat forever.

The two permanent social missions (follow @doggiezenfam on X, join the Telegram channel —
10,000 $DOGZ each, one-time-ever) are verified very differently from each other:

- **Join Telegram** is checked for real. `/api/social/claim` calls Telegram's
  `getChatMember` and only pays out if the player is actually in the channel. This requires
  the bot to be a member (in practice, an admin) of that channel — see
  `TELEGRAM_CHANNEL_USERNAME` in `.env.example`.
- **Follow on X** cannot be checked directly — confirming an actual follow relationship
  requires paid, elevated X API access this project doesn't have. Instead, `/api/social/open`
  hands the player a short piece of text to post publicly on X containing a per-player
  code (`tweetVerificationText()` in `server.js`), and `/api/social/verify-tweet` confirms —
  via X's public, no-API-key oEmbed endpoint (`https://publish.twitter.com/oembed`) — that a
  real, public post at the URL the player pastes back actually contains that code. This
  proves a real, attributable public action was taken; it does **not** prove the player
  actually followed the account, since X doesn't expose that relationship without paid API
  access. `/api/social/claim` still additionally requires `/api/social/open` to have been
  called first and `SOCIAL_MIN_DWELL_MS` to have passed, and the reward is strictly
  single-use per player (the `claimed` flag never resets). If real follow verification
  becomes available (e.g. an X API tier that supports it), it can be dropped in the same way
  `checkTelegramMembership()` was for the Telegram mission.

## Daily retention

`/api/daily/claim` is a simple login-streak hook: calling it pays out a reward once per
calendar day (server clock, UTC), escalating over a 7-day cycle before repeating —
`DAILY_STREAK_REWARDS = [20, 30, 40, 60, 80, 120, 200]` in `server.js`. Missing a day resets
the streak back to 1 rather than locking the player out; a lapsed player just starts over,
they're never blocked from playing. Like the social missions, this is a small fixed amount
gated by `lastCheckinDate`, not run through `DAILY_COIN_CAP` — it can't be repeated to farm
coins the way a run score could.

The client calls `/api/state` on load, which reports `streak.claimedToday` — if that's
`false`, it shows a claim popup and calls `/api/daily/claim` when the player taps Claim. The
server is the sole authority on the streak count and the reward; the popup only ever
displays what the server most recently confirmed.

## Admin

`GET /api/admin/flagged` returns the accounts the flap-evidence anti-cheat check
(`evaluateFlapEvidence()`, see "Anti-cheat, honestly" above) has flagged, most-flagged
first — a read-only view for manual spot-checks, not an automated ban list. It's gated by
`ADMIN_TOKEN` in `.env`: unset by default, which disables the endpoint entirely (404) rather
than leaving it open. To use it, set `ADMIN_TOKEN` to a long random secret and pass it as
the `X-Admin-Token` header:

```bash
curl -H "X-Admin-Token: your-admin-token" https://your-server.com/api/admin/flagged
```

Treat `ADMIN_TOKEN` the same as `TELEGRAM_BOT_TOKEN` — a real secret, never committed to
git, never exposed to the client.

## Referrals

The referral flow is server-verified: `startParam` (the referral code from the invite link)
is only trusted on a brand-new player's very first `/api/state` call, and only after their
`initData` has been verified as a real, unique Telegram account — that call just remembers
`referredBy`, though, it doesn't pay anyone yet.

The referrer is credited 50 $DOGZ **once the referred player finishes their first real run**
(checked inside `/api/run/submit`, guarded by the `referralCredited` flag so it can only ever
fire once), not the instant the invite link is opened. The old instant-credit version could be
farmed for free by spinning up throwaway Telegram accounts that never actually played;
requiring one completed run first raises the bar without needing device or IP fingerprinting.
It's still not airtight — nothing server-side stops one person from actually playing a run on
several real Telegram accounts — but it closes the zero-effort version of the exploit.

## Rate limiting

Rate limits (per-IP globally, and tighter per-player limits on the sensitive endpoints) and
open run tokens both live in `store.js`, behind a small async interface so the rest of the
backend doesn't care which implementation is active:

- **Default (no `REDIS_URL` set):** in-memory, same as before. Zero setup, fine for a
  single server instance. State resets if the process restarts, and isn't shared if you
  ever run more than one instance behind a load balancer. If `NODE_ENV=production` and
  `REDIS_URL` isn't set, the server logs a loud warning on boot about exactly this — it's
  not fatal (plenty of small deployments never need more than one instance), just easy to
  overlook otherwise.
- **`REDIS_URL` set:** rate-limit counters and run tokens are stored in Redis instead —
  they survive a restart and are correctly shared across as many instances as you run.
  `ioredis` is an optional dependency (only required at runtime if you actually set
  `REDIS_URL`), so it doesn't force Redis on anyone who doesn't need it yet.

Start with the default; add `REDIS_URL` (a managed Redis add-on works fine) once you're
actually scaling past one instance.

## Testing

`npm test` runs `test-logic.js` (dependency-free) then `test-integration.js` (real HTTP
requests against the app via `supertest`, using an isolated `:memory:` SQLite db — never
touches the real `data.sqlite`).

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs this same `npm test` automatically
on every push and pull request to `main`, on Node 18 and 20, so a broken test blocks the merge
instead of only surfacing when someone remembers to run it locally. It uses `npm install`
rather than `npm ci` because the repo doesn't commit a `package-lock.json` — if you add one
(`npm install` locally, then commit the generated file), switch the workflow to `npm ci` for
faster, fully reproducible installs.

## Scaling past a single file

`db.js` is now backed by SQLite (`better-sqlite3`) instead of rewriting one JSON file on
every save. It keeps an in-process cache of touched player rows and flushes only the dirty
ones in a single transaction, and the leaderboard is served by an indexed SQL query instead
of pulling every player into memory and sorting in JS. That's still a single file on disk
with zero external infra to run — a big step up from the old JSON approach at a similar
setup cost — but it's still one file on one host: it doesn't help if you ever need multiple
server instances writing to the same database at once. If DoggieZen gets real multi-instance
traffic, swap `db.js` for a networked database (Postgres, MySQL, etc.); every other file
only calls the functions `db.js` exports (`getPlayer`, `playerExists`, `topPlayers`,
`rankOf`, `save`), so that's the one place to change.

**Automatic backups.** Since it's one file on one host, `db.js` also writes a full online
backup (via `better-sqlite3`'s native `.backup()` — safe to run while the db is live, doesn't
block reads or writes) every `BACKUP_INTERVAL_MS` (default 6h) to `BACKUP_DIR` (default a
`backups/` folder next to the db file), and prunes down to the newest `BACKUP_KEEP` (default
14) afterward so disk usage doesn't grow forever. All three are optional env vars — see
`.env.example`. Disabled entirely for the `:memory:` db the test suite uses. This covers
"the disk dies" or "a bad deploy corrupts data.sqlite"; it does not cover point-in-time
recovery mid-day (the granularity is whatever `BACKUP_INTERVAL_MS` is set to) — for that,
you'd want the networked-database migration above, most of which have that built in.

## Still placeholder / left for you

- **Zen Pass**: intentionally empty in the client ("hasn't taken off yet") — there's no
  season-pass system designed yet, this wasn't a bug to fix, just a feature not started.
- **A real coin sink**: $DOGZ can currently only be earned, never spent — there's no shop,
  cosmetic store, or Zen Pass to redeem it against yet. The Wallet screen (`renderers.wallet`
  in the client, `/api/wallet` above) shows the full earn-side ledger, but until there's
  something to spend on, it's a one-directional balance rather than a real economy.
- **A fully authoritative anti-cheat (server-side physics replay)**: mostly done — see
  "Anti-cheat, honestly" above and `physics.js`. What's left is tuning `REPLAY_SCORE_TOLERANCE`
  against real device/timing data once this has actually run in production (it's currently a
  conservative guess), and eventually retiring the `evaluateFlapEvidence()` fallback path once
  every client in the wild is new enough to always send a replayable seed.
- **Real "follow on X" verification**: see "Anti-cheat, honestly" above — blocked on X's paid
  API tier, not something fixable from this codebase alone.
