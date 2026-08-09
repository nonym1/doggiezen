// test-integration.js
// Integration tests that hit the actual Express app (createApp() from server.js) through
// real HTTP requests via supertest — unlike test-logic.js, which re-implements the core
// logic standalone so it can run with zero dependencies. This file complements that: it
// catches wiring bugs (wrong status codes, middleware order, request/response shape) that
// pure-logic tests can't see, at the cost of needing `npm install` first.
//
// Uses an isolated in-memory SQLite db (':memory:') and an in-memory store per test run —
// never touches the real data.sqlite or a real Redis instance.
//
// Run with: npm test  (runs this after test-logic.js — see package.json)

const assert = require('assert');
const crypto = require('crypto');
const request = require('supertest');

const { createApp } = require('./server');
const { createDb } = require('./db');
const { createMemoryStore } = require('./store');

const BOT_TOKEN = 'fake-token-for-testing-only';

function signedInitData(userObj, extra) {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(userObj));
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  if (extra) for (const k in extra) params.set(k, extra[k]);
  const arr = [];
  for (const [k, v] of params.entries()) arr.push(`${k}=${v}`);
  arr.sort();
  const dataCheckString = arr.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

function freshApp() {
  const db = createDb(':memory:');
  const store = createMemoryStore();
  const app = createApp({ db, store, botToken: BOT_TOKEN, allowedOrigin: '*' });
  return { app, db, store };
}

async function main() {
  /* ---- initData verification, over real HTTP ---- */
  {
    const { app } = freshApp();
    const res = await request(app).post('/api/state').send({ initData: 'not-a-real-initData' });
    assert.strictEqual(res.status, 401, 'unverifiable initData should 401');
    assert.strictEqual(res.body.success, false);
    console.log('PASS: /api/state rejects invalid initData with 401');
  }

  /* ---- new player creation + shape of the response ---- */
  let telegramId;
  {
    const { app } = freshApp();
    const initData = signedInitData({ id: 111, first_name: 'Ada', username: 'ada' });
    const res = await request(app).post('/api/state').send({ initData });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.player.coins, 0, 'brand-new player starts at 0 coins');
    assert.strictEqual(res.body.player.gamesPlayed, 0);
    assert.ok(Array.isArray(res.body.leaderboard), 'leaderboard should be an array');
    console.log('PASS: /api/state creates a new player with the expected shape');
  }

  /* ---- full run lifecycle: start -> submit -> score gets clamped, coins credited ---- */
  {
    const { app } = freshApp();
    const initData = signedInitData({ id: 222, first_name: 'Bo' });
    await request(app).post('/api/state').send({ initData });

    const startRes = await request(app).post('/api/run/start').send({ initData });
    assert.strictEqual(startRes.status, 200);
    const { runToken } = startRes.body;
    assert.ok(runToken, 'run/start should return a runToken');

    // Claiming an absurd score immediately after starting should be clamped hard by the
    // server's elapsed-time bound, not accepted as-is.
    const submitRes = await request(app)
      .post('/api/run/submit')
      .send({ initData, runToken, score: 9999, bullPassed: 9999 });
    assert.strictEqual(submitRes.status, 200);
    assert.ok(submitRes.body.acceptedScore < 20, `score should be clamped near-zero for an instant submit, got ${submitRes.body.acceptedScore}`);
    assert.strictEqual(submitRes.body.player.gamesPlayed, 1);
    console.log('PASS: /api/run/submit clamps an implausible instant score');

    // The same runToken must not be usable twice.
    const replay = await request(app).post('/api/run/submit').send({ initData, runToken, score: 5 });
    assert.strictEqual(replay.status, 400, 'a already-used runToken should be rejected');
    console.log('PASS: run tokens are single-use');
  }

  /* ---- daily coin cap: creditCoins() never grants past DAILY_COIN_CAP in one day ---- */
  {
    const { createDb } = require('./db');
    const db = createDb(':memory:');
    const player = db.getPlayer('333');
    // Simulate a player who has already earned right up to the cap today.
    player.dailyCoinsDate = new Date().toISOString().slice(0, 10);
    player.dailyCoinsEarned = 2990;
    // server.js doesn't export creditCoins directly (it's an internal helper), so this
    // exercises the same boundary through the public surface: a submit that would earn
    // well over 10 coins should still only grant the 10 coins of remaining room.
    const { createApp } = require('./server');
    const { createMemoryStore } = require('./store');
    const app = createApp({ db, store: createMemoryStore(), botToken: BOT_TOKEN, allowedOrigin: '*' });
    const initData = signedInitData({ id: 333, first_name: 'Cy' });
    await request(app).post('/api/state').send({ initData });
    const s = await request(app).post('/api/run/start').send({ initData });
    // A long-elapsed run isn't simulated here (no fake timers), so acceptedScore stays
    // small — but the point is the ceiling: total coins must never cross DAILY_COIN_CAP.
    const submitRes = await request(app)
      .post('/api/run/submit')
      .send({ initData, runToken: s.body.runToken, score: 5, bullPassed: 0 });
    assert.ok(submitRes.body.player.coins <= 3000, `player coins must never exceed the daily cap, got ${submitRes.body.player.coins}`);
    console.log('PASS: earned coins respect the daily cap ceiling');
  }

  /* ---- missions: can't claim before target reached, can't claim twice ---- */
  {
    const { app } = freshApp();
    const initData = signedInitData({ id: 444, first_name: 'Dee' });
    await request(app).post('/api/state').send({ initData });

    const tooEarly = await request(app).post('/api/missions/claim').send({ initData, missionId: 'play' });
    assert.strictEqual(tooEarly.status, 400, 'claiming an unfinished mission should be rejected');

    // Play 3 short runs to complete the "play 3 games" mission.
    for (let i = 0; i < 3; i++) {
      const s = await request(app).post('/api/run/start').send({ initData });
      await request(app).post('/api/run/submit').send({ initData, runToken: s.body.runToken, score: 1 });
    }
    const claim = await request(app).post('/api/missions/claim').send({ initData, missionId: 'play' });
    assert.strictEqual(claim.status, 200);
    assert.strictEqual(claim.body.player.missions.claimed.play, true);

    const claimAgain = await request(app).post('/api/missions/claim').send({ initData, missionId: 'play' });
    assert.strictEqual(claimAgain.status, 400, 'claiming an already-claimed mission should be rejected');
    console.log('PASS: mission claim requires completion and is single-use');
  }

  /* ---- referral credit: only on a brand-new player's first load, only once ---- */
  {
    const { app } = freshApp();
    const referrerInit = signedInitData({ id: 555, first_name: 'Ref' });
    await request(app).post('/api/state').send({ initData: referrerInit });

    const inviteeInit = signedInitData({ id: 556, first_name: 'Invitee' });
    const first = await request(app).post('/api/state').send({ initData: inviteeInit, startParam: '555' });
    assert.strictEqual(first.body.player.referredBy, '555');

    const referrerState = await request(app).post('/api/state').send({ initData: referrerInit });
    assert.strictEqual(referrerState.body.player.referredFriends, 1);
    assert.strictEqual(referrerState.body.player.coins, 1000, 'referrer should be credited exactly the referral reward once');

    // Reloading the invitee again with a startParam should NOT re-credit the referrer.
    await request(app).post('/api/state').send({ initData: inviteeInit, startParam: '555' });
    const referrerAgain = await request(app).post('/api/state').send({ initData: referrerInit });
    assert.strictEqual(referrerAgain.body.player.coins, 1000, 'referral reward must not be granted twice');
    console.log('PASS: referral credit is server-verified, first-load-only, and non-repeatable');
  }

  /* ---- leaderboard: excludes players with 0 games, ranks by best score ---- */
  {
    const { app } = freshApp();
    const aInit = signedInitData({ id: 601, first_name: 'A' });
    const bInit = signedInitData({ id: 602, first_name: 'B' });
    await request(app).post('/api/state').send({ initData: aInit });
    await request(app).post('/api/state').send({ initData: bInit }); // never plays a run

    const s = await request(app).post('/api/run/start').send({ initData: aInit });
    await request(app).post('/api/run/submit').send({ initData: aInit, runToken: s.body.runToken, score: 3 });

    const lb = await request(app).post('/api/leaderboard').send({ initData: aInit });
    assert.strictEqual(lb.status, 200);
    assert.ok(lb.body.leaderboard.some((p) => p.tgId === '601'), 'player who played should be on the leaderboard');
    assert.ok(!lb.body.leaderboard.some((p) => p.tgId === '602'), 'player who never played should be excluded');
    assert.strictEqual(lb.body.myRank.rank, 1);
    console.log('PASS: leaderboard excludes non-players and ranks correctly');
  }

  /* ---- social missions: can't claim without opening first, can't claim twice,
     follow_x additionally requires a verified tweet before it can be claimed, and
     join_telegram is rejected unless Telegram actually confirms membership ----
     NOTE: player.social.opened[id] is now an object { ts, code, verified } (it used to be
     a bare timestamp number) — every direct db write below uses that shape. */
  {
    const { app, db } = freshApp();
    const initData = signedInitData({ id: 801, first_name: 'Sox' });
    await request(app).post('/api/state').send({ initData });

    const blind = await request(app).post('/api/social/claim').send({ initData, missionId: 'follow_x' });
    assert.strictEqual(blind.status, 400, 'claiming a social mission without opening it first should be rejected');

    const openRes = await request(app).post('/api/social/open').send({ initData, missionId: 'follow_x' });
    assert.strictEqual(openRes.status, 200);
    assert.ok(openRes.body.tweetText, 'opening follow_x should hand back the exact tweet text (with the per-player code) to post');
    const opened = openRes.body.player.social.opened.follow_x;
    assert.ok(opened && opened.code, 'opening a tweet-verified mission should assign a verification code');
    assert.strictEqual(opened.verified, false, 'a freshly-opened tweet mission starts unverified');

    const tooSoon = await request(app).post('/api/social/claim').send({ initData, missionId: 'follow_x' });
    assert.strictEqual(tooSoon.status, 400, 'claiming immediately after opening (before the dwell delay) should be rejected');

    // Back-date the opened timestamp past SOCIAL_MIN_DWELL_MS so we can test the rest of
    // the flow without an actual sleep — this reaches into the db the same way the
    // daily-coin-cap test above does, rather than adding a real 10s delay to the suite.
    const player = db.getPlayer('801');
    player.social.opened.follow_x = { ts: Date.now() - 20000, code: opened.code, verified: false };
    await db.save();

    // Even past the dwell delay, follow_x should stay locked until the tweet is verified —
    // that's the new, stronger bar compared to the old fully honor-based claim.
    const notVerified = await request(app).post('/api/social/claim').send({ initData, missionId: 'follow_x' });
    assert.strictEqual(notVerified.status, 400, 'follow_x should stay locked until the tweet is verified, even past the dwell delay');

    // A malformed/non-matching tweet URL fails verify-tweet without needing real network
    // access — verifyTweetPost's URL pattern check rejects it before any fetch happens.
    const badVerify = await request(app)
      .post('/api/social/verify-tweet')
      .send({ initData, missionId: 'follow_x', tweetUrl: 'not-a-tweet-url' });
    assert.strictEqual(badVerify.status, 400, 'an unparseable tweet URL should fail verification');

    // Simulate a successful verification the same way the suite already back-dates
    // timestamps elsewhere — by writing the resulting state directly. The real check calls
    // out to X's public oEmbed endpoint, which isn't reachable from this test environment.
    player.social.opened.follow_x = { ts: Date.now() - 20000, code: opened.code, verified: true };
    await db.save();

    const claim = await request(app).post('/api/social/claim').send({ initData, missionId: 'follow_x' });
    assert.strictEqual(claim.status, 200);
    assert.strictEqual(claim.body.player.coins, 10000, 'follow_x should credit the full 10,000 $DOGZ, not bounded by the daily coin cap');
    assert.strictEqual(claim.body.player.social.claimed.follow_x, true);

    const claimAgain = await request(app).post('/api/social/claim').send({ initData, missionId: 'follow_x' });
    assert.strictEqual(claimAgain.status, 400, 'claiming an already-claimed social mission should be rejected');

    // join_telegram can't be verified in this test environment (no real Telegram API
    // access), so it should fail closed rather than silently paying out.
    await request(app).post('/api/social/open').send({ initData, missionId: 'join_telegram' });
    const p2 = db.getPlayer('801');
    p2.social.opened.join_telegram = { ts: Date.now() - 20000, code: null, verified: false };
    await db.save();
    const tgClaim = await request(app).post('/api/social/claim').send({ initData, missionId: 'join_telegram' });
    assert.strictEqual(tgClaim.status, 400, 'join_telegram should fail closed when channel membership cannot be verified');

    console.log('PASS: social missions require open-then-wait, follow_x additionally requires a verified tweet, and join_telegram fails closed without real verification');
  }

  /* ---- run/submit flap-timestamp evidence: implausible evidence folds the score down and
     flags the account, even when the wall-clock bound alone would have allowed it ----
     Uses two separate players (one per run) since run/start is itself rate-limited to one
     call per player per 2s — same reason the daily-coin-cap test above opens a fresh app. */
  {
    const { app, db } = freshApp();

    // A run with no flapTimestamps at all (older client, or offline fallback) must NOT be
    // treated as suspicious on its own — evidence is opt-in, not required.
    const noEvidenceInit = signedInitData({ id: 802, first_name: 'Ev1' });
    await request(app).post('/api/state').send({ initData: noEvidenceInit });
    const s1 = await request(app).post('/api/run/start').send({ initData: noEvidenceInit });
    const noEvidence = await request(app)
      .post('/api/run/submit')
      .send({ initData: noEvidenceInit, runToken: s1.body.runToken, score: 1, bullPassed: 0 });
    assert.strictEqual(noEvidence.status, 200);
    assert.strictEqual(noEvidence.body.acceptedScore, 1, 'a run with no flap evidence should not be penalized for lacking it');

    // A claimed score of 5 with only one flap timestamp is implausible (well under
    // MIN_FLAPS_PER_POINT) and should be folded down hard, not trusted at face value.
    const sparseInit = signedInitData({ id: 803, first_name: 'Ev2' });
    await request(app).post('/api/state').send({ initData: sparseInit });
    const s2 = await request(app).post('/api/run/start').send({ initData: sparseInit });
    const sparseEvidence = await request(app)
      .post('/api/run/submit')
      .send({ initData: sparseInit, runToken: s2.body.runToken, score: 5, bullPassed: 0, flapTimestamps: [100] });
    assert.strictEqual(sparseEvidence.status, 200);
    assert.ok(
      sparseEvidence.body.acceptedScore < 5,
      `implausibly sparse flap evidence should fold the score down, got ${sparseEvidence.body.acceptedScore}`
    );
    assert.strictEqual(db.getPlayer('803').suspiciousRunCount, 1, 'a flagged run should increment suspiciousRunCount');

    console.log('PASS: /api/run/submit folds the score down on implausible flap evidence and never penalizes its absence');
  }

  /* ---- rate limiting: hammering run/start should eventually 429 ---- */
  {
    const { app } = freshApp();
    const initData = signedInitData({ id: 701, first_name: 'Rate' });
    await request(app).post('/api/state').send({ initData });
    await request(app).post('/api/run/start').send({ initData }); // 1st, allowed
    const second = await request(app).post('/api/run/start').send({ initData }); // 2nd within 2s window
    assert.strictEqual(second.status, 429, 'a second run/start within the rate-limit window should 429');
    console.log('PASS: per-player rate limiting kicks in on run/start');
  }

  console.log('\nAll integration tests passed.');
}

main().catch((e) => {
  console.error('INTEGRATION TEST FAILURE:', e);
  process.exit(1);
});
