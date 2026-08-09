// store-blobs.js
// Netlify Blobs-backed implementation of store.js's interface: isRateLimited, openRun,
// consumeRun, saveZenPassIntent, getZenPassIntent, clearZenPassIntent, close. Used by
// netlify/functions/api.js instead of store.js's in-memory/Redis implementations — those
// don't fit Netlify Functions (in-memory state doesn't survive between invocations; the
// person explicitly chose not to add Redis). See store.js for what each method means; the
// contract here is identical, just backed by Blobs instead of a Map or Redis.
//
// The one thing that genuinely needs to be atomic is consumeRun() — a run token must be
// usable exactly once even if two /api/run/submit requests race. Blobs doesn't have Redis's
// GETDEL, so this uses an optimistic compare-and-swap instead: read the token with its ETag,
// then try to overwrite it (marking it consumed) with onlyIfMatch: etag. Only the request
// that wins that conditional write gets to use the token; a request that loses the race gets
// null, same as if store.js's Redis GETDEL had already removed it.

const { getStore } = require('@netlify/blobs');

const ZEN_PASS_INTENT_TTL_MS = 20 * 60 * 1000;
const AUTO_PILOT_INTENT_TTL_MS = ZEN_PASS_INTENT_TTL_MS; // same abandon-window, separate purchase flow
const RUN_TOKEN_TTL_MS = 15 * 60 * 1000; // generous — well past MAX_RUN_DURATION_MS in server.js

function createStore() {
  const rateStore = getStore({ name: 'doggiezen-ratelimit' });
  const runStore = getStore({ name: 'doggiezen-runs' });
  const zenpassIntentStore = getStore({ name: 'doggiezen-zenpass-intents' });
  const autopilotIntentStore = getStore({ name: 'doggiezen-autopilot-intents' });

  return {
    kind: 'blobs',

    // Best-effort fixed-window counter. A rare lost increment under heavy concurrent
    // traffic to the exact same key just means the limit is very slightly soft — never a
    // correctness problem the way a lost run-token or double-counted payment would be, so
    // this doesn't need the same CAS-retry treatment as consumeRun()/recordZenPassPayment().
    async isRateLimited(key, windowMs, max) {
      const blobKey = 'rl:' + key;
      const now = Date.now();
      const { data, etag } = (await rateStore
        .getWithMetadata(blobKey, { type: 'json' })
        .catch(() => null)) || { data: null, etag: null };
      let bucket = data && now <= data.resetAt ? data : { count: 0, resetAt: now + windowMs };
      bucket = { count: bucket.count + 1, resetAt: bucket.resetAt };
      const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
      const result = await rateStore.setJSON(blobKey, bucket, opts);
      if (!result || result.modified === false) {
        // Someone else wrote this key at the same instant — treat as one more request
        // against the window rather than retrying; see the comment above.
        return bucket.count > max;
      }
      return bucket.count > max;
    },

    async openRun(telegramId, token, seed) {
      await runStore.setJSON('run:' + telegramId, { token, startedAt: Date.now(), seed, consumed: false });
    },

    async consumeRun(telegramId, token) {
      const key = 'run:' + telegramId;
      const { data, etag } = (await runStore
        .getWithMetadata(key, { type: 'json' })
        .catch(() => null)) || { data: null, etag: null };
      if (!data || data.token !== token || data.consumed) return null;
      if (Date.now() - data.startedAt > RUN_TOKEN_TTL_MS) return null;
      const result = await runStore.setJSON(key, { ...data, consumed: true }, { onlyIfMatch: etag });
      if (!result || result.modified === false) return null; // lost the race — already consumed
      return { startedAt: data.startedAt, seed: data.seed };
    },

    async saveZenPassIntent(telegramId, intent) {
      await zenpassIntentStore.setJSON('intent:' + telegramId, {
        intent,
        expiresAt: Date.now() + ZEN_PASS_INTENT_TTL_MS,
      });
    },

    async getZenPassIntent(telegramId) {
      const key = 'intent:' + telegramId;
      const entry = await zenpassIntentStore.get(key, { type: 'json' });
      if (!entry || Date.now() > entry.expiresAt) {
        if (entry) await zenpassIntentStore.delete(key);
        return null;
      }
      return entry.intent;
    },

    async clearZenPassIntent(telegramId) {
      await zenpassIntentStore.delete('intent:' + telegramId);
    },

    async saveAutoPilotIntent(telegramId, intent) {
      await autopilotIntentStore.setJSON('intent:' + telegramId, {
        intent,
        expiresAt: Date.now() + AUTO_PILOT_INTENT_TTL_MS,
      });
    },

    async getAutoPilotIntent(telegramId) {
      const key = 'intent:' + telegramId;
      const entry = await autopilotIntentStore.get(key, { type: 'json' });
      if (!entry || Date.now() > entry.expiresAt) {
        if (entry) await autopilotIntentStore.delete(key);
        return null;
      }
      return entry.intent;
    },

    async clearAutoPilotIntent(telegramId) {
      await autopilotIntentStore.delete('intent:' + telegramId);
    },

    async close() {
      /* nothing to close — Netlify Blobs has no persistent connection */
    },
  };
}

module.exports = { createStore };
