// store.js
// Home for the two pieces of state that used to live in plain module-level Maps in
// server.js: rate-limit counters and open run tokens. Both are short-lived (run tokens
// expire within MAX_RUN_DURATION_MS; rate-limit windows are seconds-to-minutes), so losing
// them on a restart is a minor inconvenience, not a correctness problem — but they also
// don't survive a restart or get shared across multiple server instances, which matters
// once you're behind a load balancer running more than one instance.
//
// This module keeps the zero-setup in-memory behavior as the default (fine for a single
// instance) and adds an optional Redis-backed implementation: set REDIS_URL and both
// problems go away — state survives restarts and is shared across every instance. Nothing
// else in the codebase needs to know which one is active; both implement the same async
// interface.

/* ===================== in-memory implementation (default, single-instance only) ===================== */

const ZEN_PASS_INTENT_TTL_MS = 20 * 60 * 1000; // a pending Zen Pass purchase is abandoned after this long
const AUTO_PILOT_INTENT_TTL_MS = ZEN_PASS_INTENT_TTL_MS; // same abandon-window, separate purchase flow

function createMemoryStore() {
  const buckets = new Map(); // rate-limit key -> {count, resetAt}
  const runs = new Map(); // telegramId -> {token, startedAt}
  const zenPassIntents = new Map(); // telegramId -> {intent, expiresAt}
  const autoPilotIntents = new Map(); // telegramId -> {intent, expiresAt}

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now > bucket.resetAt) buckets.delete(key);
    }
  }, 5 * 60 * 1000);
  cleanupTimer.unref();

  return {
    kind: 'memory',
    async isRateLimited(key, windowMs, max) {
      const now = Date.now();
      let bucket = buckets.get(key);
      if (!bucket || now > bucket.resetAt) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count++;
      return bucket.count > max;
    },
    async openRun(telegramId, token, seed) {
      runs.set(telegramId, { token, startedAt: Date.now(), seed });
    },
    async consumeRun(telegramId, token) {
      const entry = runs.get(telegramId);
      if (!entry || entry.token !== token) return null;
      runs.delete(telegramId); // single use
      return { startedAt: entry.startedAt, seed: entry.seed };
    },
    // Zen Pass purchase intents — unlike run tokens (openRun/consumeRun, single-use), an
    // intent is read repeatedly while the client polls /api/zenpass/purchase/confirm waiting
    // for the on-chain transaction to land, so it needs a non-destructive read
    // (getZenPassIntent) plus an explicit clear once the purchase actually succeeds. Storing
    // one intent per telegramId (overwriting any previous one) mirrors openRun's "only one
    // in-flight thing per player" shape — a player can only be mid-purchase once at a time.
    async saveZenPassIntent(telegramId, intent) {
      zenPassIntents.set(telegramId, { intent, expiresAt: Date.now() + ZEN_PASS_INTENT_TTL_MS });
    },
    async getZenPassIntent(telegramId) {
      const entry = zenPassIntents.get(telegramId);
      if (!entry || Date.now() > entry.expiresAt) {
        zenPassIntents.delete(telegramId);
        return null;
      }
      return entry.intent;
    },
    async clearZenPassIntent(telegramId) {
      zenPassIntents.delete(telegramId);
    },
    // Auto Pilot purchase intents — same shape and lifecycle as the Zen Pass intents above,
    // kept in a separate Map so an in-flight Zen Pass purchase and an in-flight Auto Pilot
    // purchase for the same player don't clobber each other.
    async saveAutoPilotIntent(telegramId, intent) {
      autoPilotIntents.set(telegramId, { intent, expiresAt: Date.now() + AUTO_PILOT_INTENT_TTL_MS });
    },
    async getAutoPilotIntent(telegramId) {
      const entry = autoPilotIntents.get(telegramId);
      if (!entry || Date.now() > entry.expiresAt) {
        autoPilotIntents.delete(telegramId);
        return null;
      }
      return entry.intent;
    },
    async clearAutoPilotIntent(telegramId) {
      autoPilotIntents.delete(telegramId);
    },
    async close() {
      clearInterval(cleanupTimer);
    },
  };
}

/* ===================== Redis implementation (opt-in, multi-instance safe) ===================== */

function createRedisStore(redisUrl) {
  // Lazy require so `ioredis` is only a hard dependency if you actually set REDIS_URL —
  // it's listed as an optionalDependency in package.json for exactly that reason.
  const Redis = require('ioredis');
  const redis = new Redis(redisUrl);

  return {
    kind: 'redis',
    async isRateLimited(key, windowMs, max) {
      // INCR + PEXPIRE NX gives an atomic fixed-window counter without a round-trip race:
      // the expiry is only set the first time the key is created in this window.
      const rkey = `ratelimit:${key}`;
      const count = await redis.incr(rkey);
      if (count === 1) await redis.pexpire(rkey, windowMs);
      return count > max;
    },
    async openRun(telegramId, token, seed) {
      // Stored with a generous TTL (well past MAX_RUN_DURATION_MS) so a token nobody ever
      // submits doesn't linger forever, without racing the game's own run-duration cap.
      await redis.set(`run:${telegramId}`, JSON.stringify({ token, startedAt: Date.now(), seed }), 'EX', 15 * 60);
    },
    async consumeRun(telegramId, token) {
      const rkey = `run:${telegramId}`;
      const raw = await redis.get(rkey);
      if (!raw) return null;
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch (e) {
        return null;
      }
      if (entry.token !== token) return null;
      await redis.del(rkey); // single use
      return { startedAt: entry.startedAt, seed: entry.seed };
    },
    // See the in-memory implementation above for why this needs a non-destructive read
    // (getZenPassIntent) separate from an explicit clear, unlike openRun/consumeRun.
    async saveZenPassIntent(telegramId, intent) {
      await redis.set(`zenpass-intent:${telegramId}`, JSON.stringify(intent), 'PX', ZEN_PASS_INTENT_TTL_MS);
    },
    async getZenPassIntent(telegramId) {
      const raw = await redis.get(`zenpass-intent:${telegramId}`);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (e) {
        return null;
      }
    },
    async clearZenPassIntent(telegramId) {
      await redis.del(`zenpass-intent:${telegramId}`);
    },
    async saveAutoPilotIntent(telegramId, intent) {
      await redis.set(`autopilot-intent:${telegramId}`, JSON.stringify(intent), 'PX', AUTO_PILOT_INTENT_TTL_MS);
    },
    async getAutoPilotIntent(telegramId) {
      const raw = await redis.get(`autopilot-intent:${telegramId}`);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (e) {
        return null;
      }
    },
    async clearAutoPilotIntent(telegramId) {
      await redis.del(`autopilot-intent:${telegramId}`);
    },
    async close() {
      await redis.quit();
    },
  };
}

/** Picks Redis when REDIS_URL is set, otherwise falls back to the in-memory store. */
function createStore({ redisUrl } = {}) {
  if (redisUrl) {
    console.log('store: using Redis (state survives restarts, shared across instances)');
    return createRedisStore(redisUrl);
  }
  console.log('store: using in-memory state (fine for one instance; set REDIS_URL to persist across restarts / scale to multiple instances)');
  return createMemoryStore();
}

module.exports = { createStore, createMemoryStore, createRedisStore };
