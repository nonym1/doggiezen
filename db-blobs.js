// db-blobs.js
// Netlify Blobs-backed implementation of the same interface db.js (SQLite) exposes:
// getPlayer, playerExists, topPlayers, rankOf, flaggedPlayers, addTransaction,
// getTransactions, recordZenPassPayment, save, close. Used by netlify/functions/api.js
// instead of db.js when running on Netlify — db.js/better-sqlite3 stay untouched and are
// still what test-integration.js and any non-Netlify host use.
//
// Netlify Blobs has no query engine (no ORDER BY, no COUNT), so the leaderboard and the
// admin "flagged accounts" view are both served from one small, denormalized index blob
// (a JSON array, one lightweight entry per player who has played at least one run) instead
// of an indexed SQL table. That index is a single shared record, so every write to it uses
// an optimistic-concurrency retry (read ETag, write onlyIfMatch, retry on conflict) instead
// of a real transaction. This is a deliberate trade-off — the same one implied by choosing
// Blobs over an external database for a project this size (see DEPLOY_NETLIFY.md) — and is
// fine for a casual game's leaderboard; it is not built to stay fast with a huge player base.
//
// A createDb() instance is meant to live for exactly one request/invocation (see
// netlify/functions/api.js) — it keeps a small in-memory cache purely so a handler that
// calls getPlayer() more than once for the same id within one request doesn't re-fetch, the
// same way db.js's cache does. It is NOT safe to reuse across requests/invocations: unlike
// better-sqlite3 (an embedded file only this process writes to), Netlify Blobs is a shared
// remote store other invocations write to concurrently, so every request always reads with
// `consistency: 'strong'` and gets a fresh instance.

const { getStore } = require('@netlify/blobs');

const MAX_RETRIES = 5;

function defaultPlayer(telegramId) {
  return {
    telegramId,
    username: 'ZenPilot',
    coins: 0,
    best: 0,
    gamesPlayed: 0,
    totalPipes: 0,
    referredFriends: 0,
    referredBy: null,
    seenTutorial: false,
    missions: { resetDate: null, progress: {}, claimed: {} },
    dailyCoinsEarned: 0,
    dailyCoinsDate: null,
    social: { opened: {}, claimed: {} },
    streakCount: 0,
    longestStreak: 0,
    lastCheckinDate: null,
    suspiciousRunCount: 0,
    referralCredited: false,
    zenPassTier: 0,
    tonWalletAddress: null,
    autoPilot: false,
    createdAt: Date.now(),
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads the shared index blob (with its ETag) and applies `mutate` to it, retrying with a
 *  fresh read on a conflicting concurrent write (onlyIfMatch failure). `mutate` receives the
 *  current array (never null — defaults to []) and must return the new array to store. */
async function updateIndex(indexStore, mutate) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { data, etag } = (await indexStore.getWithMetadata('leaderboard-index', {
      type: 'json',
    }).catch(() => null)) || { data: null, etag: null };
    const current = Array.isArray(data) ? data : [];
    const next = mutate(current);
    const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const result = await indexStore.setJSON('leaderboard-index', next, opts);
    if (result && result.modified !== false) return next;
    await sleep(30 * (attempt + 1));
  }
  throw new Error('Failed to update leaderboard index after retries (concurrent writes)');
}

/** Same optimistic-concurrency pattern as updateIndex(), for a single player's wallet
 *  ledger (kept as one array-per-player blob so /api/wallet's "load more" pagination stays a
 *  cheap in-memory slice instead of another network round trip). */
async function appendTransaction(walletStore, telegramId, entry) {
  const key = 'wallet:' + telegramId;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { data, etag } = (await walletStore.getWithMetadata(key, {
      type: 'json',
    }).catch(() => null)) || { data: null, etag: null };
    const record = data && typeof data === 'object' ? data : { nextId: 1, items: [] };
    const id = record.nextId;
    const items = [{ id, amount: entry.amount, type: entry.type, description: entry.description, createdAt: entry.createdAt }, ...record.items];
    // Bound the ledger so one blob doesn't grow forever — the Wallet screen only ever pages
    // back through recent history anyway. 1000 entries is generous headroom over that.
    const trimmed = items.slice(0, 1000);
    const next = { nextId: id + 1, items: trimmed };
    const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const result = await walletStore.setJSON(key, next, opts);
    if (result && result.modified !== false) return;
    await sleep(30 * (attempt + 1));
  }
  throw new Error('Failed to append transaction after retries (concurrent writes)');
}

function createDb() {
  const playersStore = getStore({ name: 'doggiezen-players' });
  const walletStore = getStore({ name: 'doggiezen-wallet' });
  const zenpassStore = getStore({ name: 'doggiezen-zenpass-payments' });
  const autopilotStore = getStore({ name: 'doggiezen-autopilot-payments' });
  const indexStore = getStore({ name: 'doggiezen-index' });

  const cache = new Map(); // telegramId -> player object, this request only
  const dirty = new Set();

  async function loadPlayer(telegramId) {
    if (cache.has(telegramId)) return cache.get(telegramId);
    const data = await playersStore.get(telegramId, { type: 'json' });
    const player = data || defaultPlayer(telegramId);
    cache.set(telegramId, player);
    return player;
  }

  async function getPlayer(telegramId) {
    const player = await loadPlayer(telegramId);
    dirty.add(telegramId);
    return player;
  }

  async function playerExists(telegramId) {
    if (cache.has(telegramId)) return true;
    const data = await playersStore.get(telegramId, { type: 'json' });
    return !!data;
  }

  /** Flushes every player mutated via getPlayer() during this request to Blobs, and keeps
   *  the shared leaderboard/flagged index in sync for any of them with gamesPlayed > 0
   *  (mirrors idx_players_rank in db.js, which only indexes players who've played). */
  async function save() {
    if (dirty.size === 0) return;
    const ids = Array.from(dirty);
    dirty.clear();
    await Promise.all(ids.map((id) => playersStore.setJSON(id, cache.get(id))));

    const rankedIds = ids.filter((id) => cache.get(id) && cache.get(id).gamesPlayed > 0);
    if (rankedIds.length === 0) return;
    await updateIndex(indexStore, (current) => {
      const byId = new Map(current.map((e) => [e.tgId, e]));
      for (const id of rankedIds) {
        const p = cache.get(id);
        byId.set(id, {
          tgId: id,
          name: p.username,
          score: p.best,
          createdAt: p.createdAt,
          suspiciousRunCount: p.suspiciousRunCount || 0,
        });
      }
      return Array.from(byId.values());
    });
  }

  function sortedIndex(entries) {
    return [...entries].sort((a, b) => b.score - a.score || a.createdAt - b.createdAt);
  }

  async function topPlayers(limit) {
    const entries = await indexStore.get('leaderboard-index', { type: 'json' });
    return sortedIndex(entries || [])
      .slice(0, limit)
      .map((e) => ({ tgId: e.tgId, name: e.name, score: e.score }));
  }

  async function rankOf(telegramId) {
    const entries = await indexStore.get('leaderboard-index', { type: 'json' });
    const list = sortedIndex(entries || []);
    const idx = list.findIndex((e) => e.tgId === telegramId);
    if (idx === -1) return null;
    return { rank: idx + 1, score: list[idx].score };
  }

  async function flaggedPlayers(limit) {
    const entries = await indexStore.get('leaderboard-index', { type: 'json' });
    return (entries || [])
      .filter((e) => (e.suspiciousRunCount || 0) > 0)
      .sort((a, b) => (b.suspiciousRunCount || 0) - (a.suspiciousRunCount || 0))
      .slice(0, limit || 50)
      .map((e) => ({ telegramId: e.tgId, username: e.name, best: e.score, suspiciousRunCount: e.suspiciousRunCount || 0 }));
  }

  async function addTransaction(telegramId, amount, type, description) {
    await appendTransaction(walletStore, telegramId, {
      amount: Math.trunc(amount) || 0,
      type: String(type || 'other'),
      description: String(description || ''),
      createdAt: Date.now(),
    });
  }

  async function getTransactions(telegramId, limit, beforeId) {
    const record = await walletStore.get('wallet:' + telegramId, { type: 'json' });
    const items = (record && record.items) || [];
    const filtered = beforeId ? items.filter((t) => t.id < beforeId) : items;
    return filtered.slice(0, limit || 50);
  }

  /** Mirrors db.js's UNIQUE(txHash) constraint: the payment is stored keyed by txHash with
   *  onlyIfNew, so the exact same on-chain transaction can never be credited twice. On a
   *  duplicate, throws an Error whose message matches /UNIQUE/i — server.js's
   *  /api/zenpass/purchase/confirm handler specifically checks for that pattern and treats
   *  it as "already processed" rather than a real failure. */
  async function recordZenPassPayment(telegramId, tier, priceNanoTon, senderAddress, txHash) {
    const result = await zenpassStore.setJSON(
      String(txHash),
      {
        telegramId,
        tier: Math.trunc(tier),
        priceNanoTon: Math.trunc(priceNanoTon),
        senderAddress: String(senderAddress || ''),
        txHash: String(txHash),
        createdAt: Date.now(),
      },
      { onlyIfNew: true }
    );
    if (!result || result.modified === false) {
      throw new Error('UNIQUE constraint failed: zen_pass_payments.txHash');
    }
  }

  /** Mirrors recordZenPassPayment() above for the Auto Pilot one-time purchase — keyed by
   *  txHash with onlyIfNew so the same on-chain transaction can never be credited twice. */
  async function recordAutoPilotPayment(telegramId, priceNanoTon, senderAddress, txHash) {
    const result = await autopilotStore.setJSON(
      String(txHash),
      {
        telegramId,
        priceNanoTon: Math.trunc(priceNanoTon),
        senderAddress: String(senderAddress || ''),
        txHash: String(txHash),
        createdAt: Date.now(),
      },
      { onlyIfNew: true }
    );
    if (!result || result.modified === false) {
      throw new Error('UNIQUE constraint failed: auto_pilot_payments.txHash');
    }
  }

  async function close() {
    /* nothing to close — Netlify Blobs has no persistent connection */
  }

  return {
    getPlayer,
    playerExists,
    topPlayers,
    rankOf,
    flaggedPlayers,
    addTransaction,
    getTransactions,
    recordZenPassPayment,
    recordAutoPilotPayment,
    save,
    close,
  };
}

module.exports = { createDb };
