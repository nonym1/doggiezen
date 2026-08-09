// db.js
// SQLite-backed data store (via better-sqlite3 — a synchronous, embedded, zero-external-
// infra engine: no server to run, just a single .sqlite file on disk). This replaces the
// old approach of rewriting one giant JSON file on every save, which meant every write
// touched every player's data and got slower/riskier as the player count grew.
//
// Design: an in-process cache of player rows (Map), backed by SQLite. getPlayer() loads a
// row into the cache (creating it if new) and marks it dirty; save() flushes only the dirty
// rows back to disk in a single transaction. Reads for the leaderboard go straight to SQL
// (indexed on `best`), so ranking doesn't require pulling every player into memory.
//
// Exported as a factory (createDb) rather than a singleton so tests can point at an
// isolated ':memory:' or temp-file database instead of the real data.sqlite.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const DEFAULT_BACKUP_KEEP = 14; // ~3.5 days of history at the default interval

function createDb(dbFile, opts) {
  const sqlite = new Database(dbFile);
  sqlite.pragma('journal_mode = WAL'); // safe concurrent reads while a write is in flight

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS players (
      telegramId       TEXT PRIMARY KEY,
      username         TEXT NOT NULL,
      coins            INTEGER NOT NULL DEFAULT 0,
      best             INTEGER NOT NULL DEFAULT 0,
      gamesPlayed      INTEGER NOT NULL DEFAULT 0,
      totalPipes       INTEGER NOT NULL DEFAULT 0,
      referredFriends  INTEGER NOT NULL DEFAULT 0,
      referredBy       TEXT,
      seenTutorial     INTEGER NOT NULL DEFAULT 0,
      missionsResetDate TEXT,
      missionsProgress TEXT NOT NULL DEFAULT '{}',
      missionsClaimed  TEXT NOT NULL DEFAULT '{}',
      dailyCoinsEarned INTEGER NOT NULL DEFAULT 0,
      dailyCoinsDate   TEXT,
      socialOpened     TEXT NOT NULL DEFAULT '{}',
      socialClaimed    TEXT NOT NULL DEFAULT '{}',
      streakCount      INTEGER NOT NULL DEFAULT 0,
      longestStreak    INTEGER NOT NULL DEFAULT 0,
      lastCheckinDate  TEXT,
      suspiciousRunCount INTEGER NOT NULL DEFAULT 0,
      referralCredited INTEGER NOT NULL DEFAULT 0,
      zenPassTier      INTEGER NOT NULL DEFAULT 0,
      tonWalletAddress TEXT,
      autoPilot        INTEGER NOT NULL DEFAULT 0,
      createdAt        INTEGER NOT NULL
    );
    -- Leaderboard is "ORDER BY best DESC, createdAt ASC" filtered to gamesPlayed > 0 —
    -- this index lets that be a fast indexed scan instead of a full-table sort.
    CREATE INDEX IF NOT EXISTS idx_players_rank
      ON players (gamesPlayed, best DESC, createdAt ASC);

    -- Zen Pass payment ledger — one confirmed row per on-chain TON transaction that has
    -- upgraded a player's tier. txHash is UNIQUE so the exact same on-chain transaction can
    -- never be credited twice (replay protection) — see recordZenPassPayment() below and
    -- /api/zenpass/purchase/confirm in server.js, which is the only writer.
    CREATE TABLE IF NOT EXISTS zen_pass_payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      telegramId      TEXT NOT NULL,
      tier            INTEGER NOT NULL,
      priceNanoTon    INTEGER NOT NULL,
      senderAddress   TEXT NOT NULL,
      txHash          TEXT NOT NULL UNIQUE,
      createdAt       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_zenpass_player
      ON zen_pass_payments (telegramId, createdAt DESC);

    -- Auto Pilot payment ledger — mirrors zen_pass_payments above, one confirmed row per
    -- on-chain TON transaction that turned on a player's Auto Pilot flag. txHash is UNIQUE
    -- for the same replay-protection reason (see recordAutoPilotPayment() below and
    -- /api/autopilot/purchase/confirm in server.js, the only writer).
    CREATE TABLE IF NOT EXISTS auto_pilot_payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      telegramId      TEXT NOT NULL,
      priceNanoTon    INTEGER NOT NULL,
      senderAddress   TEXT NOT NULL,
      txHash          TEXT NOT NULL UNIQUE,
      createdAt       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_autopilot_player
      ON auto_pilot_payments (telegramId, createdAt DESC);

    -- Wallet ledger: one row per $DOGZ credit/debit, so the Wallet screen can show a full
    -- transaction history instead of just the running 'coins' total on the players table.
    -- Purely additive/append-only — nothing here is ever updated, only inserted and read.
    CREATE TABLE IF NOT EXISTS transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      telegramId  TEXT NOT NULL,
      amount      INTEGER NOT NULL,
      type        TEXT NOT NULL,
      description TEXT NOT NULL,
      createdAt   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tx_player
      ON transactions (telegramId, createdAt DESC);
  `);

  // Migration for databases created before permanent social missions (follow X / join
  // Telegram) existed: CREATE TABLE IF NOT EXISTS above only affects brand-new files, so
  // add the columns here too. SQLite has no "ADD COLUMN IF NOT EXISTS", so just swallow
  // the "duplicate column" error on a database that already has them.
  for (const ddl of [
    "ALTER TABLE players ADD COLUMN socialOpened TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE players ADD COLUMN socialClaimed TEXT NOT NULL DEFAULT '{}'",
    // Migration for daily login streaks (retention) and the anti-cheat suspicious-run
    // counter — same "swallow duplicate column" trick as above for pre-existing databases.
    "ALTER TABLE players ADD COLUMN streakCount INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE players ADD COLUMN longestStreak INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE players ADD COLUMN lastCheckinDate TEXT",
    "ALTER TABLE players ADD COLUMN suspiciousRunCount INTEGER NOT NULL DEFAULT 0",
    // Migration for deferred referral crediting (see /api/run/submit in server.js) — the
    // referrer is now only paid once the referred player finishes their first real run,
    // instead of the instant they open the app, so this flag tracks whether that's happened
    // yet without relying on gamesPlayed alone (which a race between two requests could
    // otherwise double-count).
    "ALTER TABLE players ADD COLUMN referralCredited INTEGER NOT NULL DEFAULT 0",
    // Migration for Zen Pass (x2/x3/x4/x5 coin multiplier, paid in TON) — see
    // "Zen Pass" in server.js. zenPassTier is 0 until the player's first purchase (tier 1 =
    // x2), then increments one tier per purchase up to the max (see ZEN_PASS_TIERS).
    // tonWalletAddress is the TON wallet last connected via TonConnect, remembered purely so
    // the Zen Pass panel can skip the "connect wallet" step on a returning visit.
    "ALTER TABLE players ADD COLUMN zenPassTier INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE players ADD COLUMN tonWalletAddress TEXT",
    // Migration for Auto Pilot (one-time Zen Pass purchase, paid in TON) — see
    // "Auto Pilot" in server.js. 0/1: whether the player has bought it.
    "ALTER TABLE players ADD COLUMN autoPilot INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      sqlite.exec(ddl);
    } catch (e) {
      /* column already exists — fine */
    }
  }

  const stmtGet = sqlite.prepare('SELECT * FROM players WHERE telegramId = ?');
  const stmtUpsert = sqlite.prepare(`
    INSERT INTO players (
      telegramId, username, coins, best, gamesPlayed, totalPipes, referredFriends,
      referredBy, seenTutorial, missionsResetDate, missionsProgress, missionsClaimed,
      dailyCoinsEarned, dailyCoinsDate, socialOpened, socialClaimed,
      streakCount, longestStreak, lastCheckinDate, suspiciousRunCount, referralCredited,
      zenPassTier, tonWalletAddress, autoPilot, createdAt
    ) VALUES (
      @telegramId, @username, @coins, @best, @gamesPlayed, @totalPipes, @referredFriends,
      @referredBy, @seenTutorial, @missionsResetDate, @missionsProgress, @missionsClaimed,
      @dailyCoinsEarned, @dailyCoinsDate, @socialOpened, @socialClaimed,
      @streakCount, @longestStreak, @lastCheckinDate, @suspiciousRunCount, @referralCredited,
      @zenPassTier, @tonWalletAddress, @autoPilot, @createdAt
    )
    ON CONFLICT(telegramId) DO UPDATE SET
      username=excluded.username, coins=excluded.coins, best=excluded.best,
      gamesPlayed=excluded.gamesPlayed, totalPipes=excluded.totalPipes,
      referredFriends=excluded.referredFriends, referredBy=excluded.referredBy,
      seenTutorial=excluded.seenTutorial, missionsResetDate=excluded.missionsResetDate,
      missionsProgress=excluded.missionsProgress, missionsClaimed=excluded.missionsClaimed,
      dailyCoinsEarned=excluded.dailyCoinsEarned, dailyCoinsDate=excluded.dailyCoinsDate,
      socialOpened=excluded.socialOpened, socialClaimed=excluded.socialClaimed,
      streakCount=excluded.streakCount, longestStreak=excluded.longestStreak,
      lastCheckinDate=excluded.lastCheckinDate, suspiciousRunCount=excluded.suspiciousRunCount,
      referralCredited=excluded.referralCredited,
      zenPassTier=excluded.zenPassTier, tonWalletAddress=excluded.tonWalletAddress,
      autoPilot=excluded.autoPilot
  `);
  const stmtTop = sqlite.prepare(`
    SELECT telegramId, username, best FROM players
    WHERE gamesPlayed > 0
    ORDER BY best DESC, createdAt ASC
    LIMIT ?
  `);
  // 1-indexed rank: how many players with gamesPlayed>0 rank strictly above this one,
  // using the same tiebreak (higher best first, then earlier createdAt first) — plus 1.
  const stmtRank = sqlite.prepare(`
    SELECT COUNT(*) AS n FROM players
    WHERE gamesPlayed > 0 AND (
      best > (SELECT best FROM players WHERE telegramId = @id)
      OR (best = (SELECT best FROM players WHERE telegramId = @id)
          AND createdAt < (SELECT createdAt FROM players WHERE telegramId = @id))
    )
  `);

  const stmtFlagged = sqlite.prepare(`
    SELECT telegramId, username, best, suspiciousRunCount FROM players
    WHERE suspiciousRunCount > 0
    ORDER BY suspiciousRunCount DESC
    LIMIT ?
  `);

  const stmtInsertZenPassPayment = sqlite.prepare(`
    INSERT INTO zen_pass_payments (telegramId, tier, priceNanoTon, senderAddress, txHash, createdAt)
    VALUES (@telegramId, @tier, @priceNanoTon, @senderAddress, @txHash, @createdAt)
  `);

  const stmtInsertAutoPilotPayment = sqlite.prepare(`
    INSERT INTO auto_pilot_payments (telegramId, priceNanoTon, senderAddress, txHash, createdAt)
    VALUES (@telegramId, @priceNanoTon, @senderAddress, @txHash, @createdAt)
  `);

  const stmtInsertTx = sqlite.prepare(`
    INSERT INTO transactions (telegramId, amount, type, description, createdAt)
    VALUES (@telegramId, @amount, @type, @description, @createdAt)
  `);
  const stmtGetTx = sqlite.prepare(`
    SELECT id, amount, type, description, createdAt FROM transactions
    WHERE telegramId = ?
    ORDER BY id DESC
    LIMIT ?
  `);
  // Cursor page: same query, but only rows older than a given id — used for "Load more" on
  // the Wallet screen once a player has scrolled past the first page (see /api/wallet).
  const stmtGetTxBefore = sqlite.prepare(`
    SELECT id, amount, type, description, createdAt FROM transactions
    WHERE telegramId = ? AND id < ?
    ORDER BY id DESC
    LIMIT ?
  `);

  const cache = new Map(); // telegramId -> player object (row, deserialized)
  const dirty = new Set();

  // Automatic backups (see backupNow() below) — disabled for the ':memory:' db the test
  // suite uses, since there's no real directory to put backup files next to.
  const backupsEnabled = dbFile !== ':memory:';
  const backupDir = (opts && opts.backupDir) || (backupsEnabled ? path.join(path.dirname(dbFile), 'backups') : null);
  const backupIntervalMs = (opts && opts.backupIntervalMs) || DEFAULT_BACKUP_INTERVAL_MS;
  const backupKeep = (opts && opts.backupKeep) || DEFAULT_BACKUP_KEEP;
  let backupTimer = null;

  function rowToPlayer(row) {
    return {
      telegramId: row.telegramId,
      username: row.username,
      coins: row.coins,
      best: row.best,
      gamesPlayed: row.gamesPlayed,
      totalPipes: row.totalPipes,
      referredFriends: row.referredFriends,
      referredBy: row.referredBy,
      seenTutorial: !!row.seenTutorial,
      missions: {
        resetDate: row.missionsResetDate,
        progress: JSON.parse(row.missionsProgress),
        claimed: JSON.parse(row.missionsClaimed),
      },
      dailyCoinsEarned: row.dailyCoinsEarned,
      dailyCoinsDate: row.dailyCoinsDate,
      // Permanent (never reset) one-time social missions — follow on X, join the Telegram
      // channel, etc. Separate from `missions` above, which resets daily.
      social: {
        opened: JSON.parse(row.socialOpened || '{}'),
        claimed: JSON.parse(row.socialClaimed || '{}'),
      },
      // Daily login streak (retention hook) — see applyDailyCheckin() in server.js.
      streakCount: row.streakCount || 0,
      longestStreak: row.longestStreak || 0,
      lastCheckinDate: row.lastCheckinDate || null,
      // Bumped by evaluateFlapEvidence() in server.js when a run's input evidence looks
      // implausible. Not shown to the player — for admin review via /api/admin/flagged.
      suspiciousRunCount: row.suspiciousRunCount || 0,
      // Whether the referral reward for whoever referred THIS player has already been paid
      // out — see the deferred-crediting note in /api/run/submit in server.js.
      referralCredited: !!row.referralCredited,
      // Zen Pass tier (0 = none, 1..4 = x2..x5 coin multiplier) — see "Zen Pass" in
      // server.js. tonWalletAddress is the TON wallet last connected via TonConnect.
      zenPassTier: row.zenPassTier || 0,
      tonWalletAddress: row.tonWalletAddress || null,
      // Auto Pilot — one-time paid upgrade, see "Auto Pilot" in server.js.
      autoPilot: !!row.autoPilot,
      createdAt: row.createdAt,
    };
  }

  function playerToRow(p) {
    return {
      telegramId: p.telegramId,
      username: p.username,
      coins: p.coins,
      best: p.best,
      gamesPlayed: p.gamesPlayed,
      totalPipes: p.totalPipes,
      referredFriends: p.referredFriends,
      referredBy: p.referredBy,
      seenTutorial: p.seenTutorial ? 1 : 0,
      missionsResetDate: p.missions.resetDate,
      missionsProgress: JSON.stringify(p.missions.progress),
      missionsClaimed: JSON.stringify(p.missions.claimed),
      dailyCoinsEarned: p.dailyCoinsEarned || 0,
      dailyCoinsDate: p.dailyCoinsDate || null,
      socialOpened: JSON.stringify((p.social && p.social.opened) || {}),
      socialClaimed: JSON.stringify((p.social && p.social.claimed) || {}),
      streakCount: p.streakCount || 0,
      longestStreak: p.longestStreak || 0,
      lastCheckinDate: p.lastCheckinDate || null,
      suspiciousRunCount: p.suspiciousRunCount || 0,
      referralCredited: p.referralCredited ? 1 : 0,
      zenPassTier: p.zenPassTier || 0,
      tonWalletAddress: p.tonWalletAddress || null,
      autoPilot: p.autoPilot ? 1 : 0,
      createdAt: p.createdAt,
    };
  }

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

  /** Returns the player object, creating one if it doesn't exist yet. Does NOT persist by
   *  itself — call save() after mutating it. Callers are expected to mutate what they get
   *  back, so this also marks the row dirty. */
  function getPlayer(telegramId) {
    if (!cache.has(telegramId)) {
      const row = stmtGet.get(telegramId);
      cache.set(telegramId, row ? rowToPlayer(row) : defaultPlayer(telegramId));
    }
    dirty.add(telegramId);
    return cache.get(telegramId);
  }

  function playerExists(telegramId) {
    if (cache.has(telegramId)) return true;
    return !!stmtGet.get(telegramId);
  }

  /** Full player list. Only used by tests / small-scale tooling now that the leaderboard
   *  itself is served by indexed SQL (topPlayers/rankOf) instead of scanning this. */
  function allPlayers() {
    const rows = sqlite.prepare('SELECT * FROM players').all();
    const merged = new Map(rows.map((r) => [r.telegramId, rowToPlayer(r)]));
    for (const [id, p] of cache) merged.set(id, p); // uncommitted in-memory changes win
    return Array.from(merged.values());
  }

  /** Top N players by best score (gamesPlayed > 0), via an indexed query — doesn't require
   *  loading every player into memory. */
  function topPlayers(limit) {
    // Flush first so a player's very first run shows up in their own leaderboard query.
    flush();
    return stmtTop.all(limit).map((r) => ({ tgId: r.telegramId, name: r.username, score: r.best }));
  }

  /** 1-indexed rank for a player, or null if they haven't played yet. */
  function rankOf(telegramId) {
    flush();
    const row = stmtGet.get(telegramId);
    if (!row || row.gamesPlayed <= 0) return null;
    const { n } = stmtRank.get({ id: telegramId });
    return { rank: n + 1, score: row.best };
  }

  /** Players flagged by the anti-cheat run-evidence check, most-flagged first — for the
   *  admin review endpoint (/api/admin/flagged in server.js). */
  function flaggedPlayers(limit) {
    flush();
    return stmtFlagged.all(limit || 50);
  }

  function flush() {
    if (dirty.size === 0) return;
    const tx = sqlite.transaction((ids) => {
      for (const id of ids) {
        const p = cache.get(id);
        if (p) stmtUpsert.run(playerToRow(p));
      }
    });
    tx(Array.from(dirty));
    dirty.clear();
  }

  /** Call after mutating anything returned by getPlayer() to write it to disk. */
  function save() {
    flush();
    return Promise.resolve();
  }

  function close() {
    flush();
    if (backupTimer) clearInterval(backupTimer);
    sqlite.close();
  }

  /** Records one $DOGZ ledger entry for a player. Written immediately (not batched through
   *  the dirty-row cache above) since a transaction row is append-only and never revised —
   *  there's nothing to coalesce the way there is for a player's mutable stat row. Amount
   *  may be negative if debits are ever introduced; every current caller only credits. */
  function addTransaction(telegramId, amount, type, description) {
    stmtInsertTx.run({
      telegramId,
      amount: Math.trunc(amount) || 0,
      type: String(type || 'other'),
      description: String(description || ''),
      createdAt: Date.now(),
    });
  }

  /** Records a confirmed Zen Pass on-chain payment. txHash is UNIQUE at the schema level, so
   *  this throws (SqliteError, code 'SQLITE_CONSTRAINT_UNIQUE') if the exact same on-chain
   *  transaction was already credited — callers (see /api/zenpass/purchase/confirm in
   *  server.js) MUST catch that and treat it as "already processed", never as a fatal error,
   *  since a client retry/poll can easily call confirm more than once for one real payment. */
  function recordZenPassPayment(telegramId, tier, priceNanoTon, senderAddress, txHash) {
    stmtInsertZenPassPayment.run({
      telegramId,
      tier: Math.trunc(tier),
      priceNanoTon: Math.trunc(priceNanoTon),
      senderAddress: String(senderAddress || ''),
      txHash: String(txHash),
      createdAt: Date.now(),
    });
  }

  /** Records a confirmed Auto Pilot on-chain payment. Same replay-protection shape as
   *  recordZenPassPayment() above (txHash UNIQUE) — callers (see
   *  /api/autopilot/purchase/confirm in server.js) MUST catch the SQLITE_CONSTRAINT_UNIQUE
   *  case and treat it as "already processed", not a fatal error. */
  function recordAutoPilotPayment(telegramId, priceNanoTon, senderAddress, txHash) {
    stmtInsertAutoPilotPayment.run({
      telegramId,
      priceNanoTon: Math.trunc(priceNanoTon),
      senderAddress: String(senderAddress || ''),
      txHash: String(txHash),
      createdAt: Date.now(),
    });
  }

  /** Most recent transactions for a player, newest first. Pass `beforeId` (the smallest id
   *  from a previous page) to fetch the next older page — used by the Wallet screen's "Load
   *  more" instead of ever having to pull a player's entire lifetime ledger at once. */
  function getTransactions(telegramId, limit, beforeId) {
    if (beforeId) return stmtGetTxBefore.all(telegramId, beforeId, limit || 50);
    return stmtGetTx.all(telegramId, limit || 50);
  }

  /** Writes a full backup of the database to <dbFile's dir>/backups/backup-<ISO time>.sqlite
   *  via better-sqlite3's native online backup API (safe to run while the db is live — it
   *  doesn't block reads/writes). Flushes dirty in-memory rows first so the backup isn't
   *  missing whatever's still uncommitted. No-op for the ':memory:' db used by tests, since
   *  there's no real file location to put backups next to. Prunes down to `backupKeep`
   *  files afterward (oldest first) so this doesn't grow disk usage unbounded. */
  async function backupNow() {
    if (!backupsEnabled) return null;
    flush();
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupDir, `backup-${stamp}.sqlite`);
    await sqlite.backup(dest);
    try {
      const files = fs
        .readdirSync(backupDir)
        .filter((f) => f.startsWith('backup-') && f.endsWith('.sqlite'))
        .sort(); // ISO-ish timestamp in the filename sorts chronologically
      for (let i = 0; i < files.length - backupKeep; i++) {
        fs.unlinkSync(path.join(backupDir, files[i]));
      }
    } catch (e) {
      console.error('[backup] cleanup of old backups failed:', e);
    }
    return dest;
  }

  if (backupsEnabled) {
    backupTimer = setInterval(() => {
      backupNow().catch((e) => console.error('[backup] scheduled backup failed:', e));
    }, backupIntervalMs);
    backupTimer.unref(); // don't keep the process alive just for this
  }

  return {
    getPlayer,
    playerExists,
    allPlayers,
    topPlayers,
    rankOf,
    flaggedPlayers,
    addTransaction,
    getTransactions,
    recordZenPassPayment,
    recordAutoPilotPayment,
    backupNow,
    save,
    close,
  };
}

module.exports = { createDb };
