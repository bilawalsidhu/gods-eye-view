import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Durable AIS voyage history (opt-in).
 *
 * `ais-store.js` keeps a bounded, process-local "recent path" that dies with
 * the server. This module is the long-lived companion: an on-disk SQLite file
 * that accumulates position fixes, identity and voyage intent across restarts,
 * so a vessel's movement can be read back weeks later.
 *
 * It is OFF unless GEV_AIS_HISTORY is set, because an always-on writer would
 * grow a database under every checkout without the operator asking for one.
 * Writes are batched into transactions — the feed delivers thousands of fixes
 * a minute and a per-row commit would dominate ingest.
 */
export const AIS_HISTORY_DEFAULTS = Object.freeze({
  dbPath: 'data/ais-history.db',
  retentionDays: 30,
  flushMs: 5000,
  maxPendingRows: 4000,
  pruneEveryMs: 60 * 60 * 1000,
});

/** Truthy env opt-in ("1", "true", "yes"), matching the repo's other flags. */
export function aisHistoryEnabled(env = process.env) {
  const raw = String(env.GEV_AIS_HISTORY ?? '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** Positive integer env read with a documented fallback. */
export function historyIntFromEnv(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vessel_track (
  mmsi TEXT NOT NULL,
  t    INTEGER NOT NULL,
  lat  REAL NOT NULL,
  lon  REAL NOT NULL,
  sog  REAL,
  cog  REAL,
  PRIMARY KEY (mmsi, t)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_vessel_track_t ON vessel_track(t);

CREATE TABLE IF NOT EXISTS vessel_identity (
  mmsi       TEXT PRIMARY KEY,
  imo        TEXT,
  name       TEXT,
  call_sign  TEXT,
  type       TEXT,
  length     REAL,
  beam       REAL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vessel_voyage (
  mmsi        TEXT NOT NULL,
  observed    INTEGER NOT NULL,
  destination TEXT,
  eta         TEXT,
  draught     REAL,
  nav_status  INTEGER,
  PRIMARY KEY (mmsi, observed)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_vessel_voyage_observed ON vessel_voyage(observed);
`;

/**
 * Opens (or creates) the history database.
 *
 * Returns null when disabled or when the file cannot be opened — a broken
 * history file must never take the live feed down with it, so every caller
 * treats null as "no history, carry on".
 *
 * @returns {Object|null} History handle, or null when unavailable.
 */
export function openAisHistory({
  dbPath = process.env.GEV_AIS_HISTORY_PATH || AIS_HISTORY_DEFAULTS.dbPath,
  retentionDays = historyIntFromEnv(
    process.env.GEV_AIS_HISTORY_RETENTION_DAYS,
    AIS_HISTORY_DEFAULTS.retentionDays,
  ),
  flushMs = AIS_HISTORY_DEFAULTS.flushMs,
  now = () => Date.now(),
} = {}) {
  let db;
  try {
    if (dbPath !== ':memory:')
      mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    db = new DatabaseSync(dbPath);
    // WAL keeps the writer from blocking the read routes mid-flush.
    if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(SCHEMA);
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* already unusable */
    }
    return { error: String(error?.message || error), disabled: true };
  }

  const insertTrack = db.prepare(
    'INSERT OR IGNORE INTO vessel_track (mmsi, t, lat, lon, sog, cog) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertVoyage = db.prepare(
    'INSERT OR IGNORE INTO vessel_voyage (mmsi, observed, destination, eta, draught, nav_status) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const upsertIdentity = db.prepare(`
    INSERT INTO vessel_identity (mmsi, imo, name, call_sign, type, length, beam, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mmsi) DO UPDATE SET
      imo       = COALESCE(NULLIF(excluded.imo, ''), vessel_identity.imo),
      name      = COALESCE(NULLIF(excluded.name, ''), vessel_identity.name),
      call_sign = COALESCE(NULLIF(excluded.call_sign, ''), vessel_identity.call_sign),
      type      = COALESCE(NULLIF(excluded.type, ''), vessel_identity.type),
      length    = COALESCE(excluded.length, vessel_identity.length),
      beam      = COALESCE(excluded.beam, vessel_identity.beam),
      last_seen = excluded.last_seen
  `);
  const selectTrack = db.prepare(
    'SELECT t, lat, lon, sog, cog FROM vessel_track WHERE mmsi = ? AND t >= ? ORDER BY t ASC LIMIT ?',
  );
  const selectVoyages = db.prepare(
    'SELECT observed, destination, eta, draught, nav_status FROM vessel_voyage WHERE mmsi = ? ORDER BY observed DESC LIMIT ?',
  );
  const selectIdentity = db.prepare(
    'SELECT mmsi, imo, name, call_sign, type, length, beam, first_seen, last_seen FROM vessel_identity WHERE mmsi = ?',
  );
  const selectDraughtRange = db.prepare(
    'SELECT MIN(draught) AS lo, MAX(draught) AS hi FROM vessel_voyage WHERE mmsi = ? AND draught IS NOT NULL AND draught > 0',
  );
  const pruneTrack = db.prepare('DELETE FROM vessel_track WHERE t < ?');
  const pruneVoyage = db.prepare(
    'DELETE FROM vessel_voyage WHERE observed < ?',
  );

  const pendingTrack = [];
  const pendingVoyage = [];
  const pendingIdentity = new Map();
  /** @type {Map<string,string>} mmsi -> last voyage fingerprint (change detection) */
  const lastVoyage = new Map();
  // Start the prune clock at open: a fresh database has nothing to prune, and
  // the first flush should not pay for a full-table scan.
  let lastPruneAt = now();
  let closed = false;
  let writes = 0;
  let flushes = 0;

  function queuePosition(mmsi, lat, lon, epochSec, sog, cog) {
    if (closed || !mmsi || !Number.isFinite(lat) || !Number.isFinite(lon))
      return;
    if (!Number.isFinite(epochSec) || epochSec <= 0) return;
    pendingTrack.push([mmsi, epochSec, lat, lon, numeric(sog), numeric(cog)]);
    if (pendingTrack.length >= AIS_HISTORY_DEFAULTS.maxPendingRows) flush();
  }

  /**
   * Records voyage intent, but only when it actually changed. Destination and
   * draught are re-broadcast every few minutes for the life of a voyage; one
   * row per broadcast would be almost entirely duplicates.
   */
  function queueVoyage(
    mmsi,
    { destination, eta, draught, navStatus } = {},
    epochSec,
  ) {
    if (closed || !mmsi) return;
    const fingerprint = [
      String(destination || ''),
      String(eta || ''),
      draught == null ? '' : Number(draught).toFixed(1),
      navStatus == null ? '' : String(navStatus),
    ].join('|');
    if (fingerprint === '|||') return;
    if (lastVoyage.get(mmsi) === fingerprint) return;
    lastVoyage.set(mmsi, fingerprint);
    pendingVoyage.push([
      mmsi,
      Number.isFinite(epochSec) && epochSec > 0
        ? epochSec
        : Math.floor(now() / 1000),
      String(destination || '') || null,
      String(eta || '') || null,
      numeric(draught),
      Number.isFinite(navStatus) ? navStatus : null,
    ]);
  }

  function queueIdentity(mmsi, identity = {}) {
    if (closed || !mmsi) return;
    pendingIdentity.set(mmsi, identity);
  }

  /** Commits every queued row in one transaction. Never throws outward. */
  function flush() {
    if (closed) return 0;
    if (!pendingTrack.length && !pendingVoyage.length && !pendingIdentity.size)
      return 0;
    const seconds = Math.floor(now() / 1000);
    let written = 0;
    try {
      db.exec('BEGIN');
      for (const row of pendingTrack) {
        insertTrack.run(...row);
        written += 1;
      }
      for (const row of pendingVoyage) {
        insertVoyage.run(...row);
        written += 1;
      }
      for (const [mmsi, identity] of pendingIdentity) {
        upsertIdentity.run(
          mmsi,
          String(identity.imo || ''),
          String(identity.name || ''),
          String(identity.callSign || ''),
          String(identity.type || ''),
          numeric(identity.length),
          numeric(identity.beam),
          seconds,
          seconds,
        );
        written += 1;
      }
      db.exec('COMMIT');
    } catch {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* transaction already unwound */
      }
      written = 0;
    }
    pendingTrack.length = 0;
    pendingVoyage.length = 0;
    pendingIdentity.clear();
    writes += written;
    flushes += 1;
    maybePrune();
    return written;
  }

  function maybePrune() {
    const nowMs = now();
    if (nowMs - lastPruneAt < AIS_HISTORY_DEFAULTS.pruneEveryMs) return;
    lastPruneAt = nowMs;
    prune();
  }

  function prune() {
    const cutoff = Math.floor(now() / 1000) - retentionDays * 86400;
    try {
      pruneTrack.run(cutoff);
      pruneVoyage.run(cutoff);
    } catch {
      /* pruning is best-effort; a locked file retries next hour */
    }
  }

  function readTrack(mmsi, { sinceSec = 0, limit = 5000 } = {}) {
    if (closed || !mmsi) return [];
    flush();
    try {
      return selectTrack
        .all(
          String(mmsi),
          Math.max(0, Math.floor(sinceSec)),
          Math.max(1, Math.floor(limit)),
        )
        .map((row) => ({
          lat: row.lat,
          lon: row.lon,
          t: row.t,
          sog: row.sog ?? null,
          cog: row.cog ?? null,
        }));
    } catch {
      return [];
    }
  }

  function readVoyages(mmsi, { limit = 200 } = {}) {
    if (closed || !mmsi) return [];
    flush();
    try {
      return selectVoyages
        .all(String(mmsi), Math.max(1, Math.floor(limit)))
        .map((row) => ({
          observed: row.observed,
          destination: row.destination || '',
          eta: row.eta || '',
          draught: row.draught ?? null,
          navStatus: row.nav_status ?? null,
        }));
    } catch {
      return [];
    }
  }

  function readIdentity(mmsi) {
    if (closed || !mmsi) return null;
    flush();
    try {
      const row = selectIdentity.get(String(mmsi));
      if (!row) return null;
      return {
        mmsi: row.mmsi,
        imo: row.imo || '',
        name: row.name || '',
        callSign: row.call_sign || '',
        type: row.type || '',
        length: row.length ?? null,
        beam: row.beam ?? null,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
      };
    } catch {
      return null;
    }
  }

  /**
   * Lowest and highest draught ever recorded for a vessel — the reference
   * range the live store needs to call a hull laden or in ballast.
   */
  function draughtExtremes(mmsi) {
    if (closed || !mmsi) return null;
    try {
      const row = selectDraughtRange.get(String(mmsi));
      if (!row || row.lo == null || row.hi == null) return null;
      return { min: row.lo, max: row.hi };
    } catch {
      return null;
    }
  }

  /**
   * Searches persisted identities.
   *
   * The live cache is process-local: a restart empties it, and a hull that
   * stopped transmitting an hour ago is gone from it entirely. The history
   * database remembers both, so a search that falls back here can still answer
   * "where was this ship" when the live feed no longer knows the name.
   */
  function searchIdentities(query, limit = 20) {
    if (closed) return [];
    const raw = String(query ?? '').trim();
    if (raw.length < 2) return [];
    flush();
    const digits = raw.replace(/\D/g, '');
    const cap = Math.max(1, Math.min(200, Math.floor(limit) || 20));
    try {
      if (digits.length >= 7) {
        const byId = db
          .prepare(
            'SELECT mmsi, imo, name, call_sign, type, length, beam, first_seen, last_seen FROM vessel_identity WHERE mmsi = ? OR imo = ? LIMIT ?',
          )
          .all(digits, digits, cap);
        if (byId.length) return byId.map(identityRow);
      }
      // Exact and prefix matches first, then substrings — same ranking the
      // live search uses, so results do not reorder when the source changes.
      return db
        .prepare(
          `SELECT mmsi, imo, name, call_sign, type, length, beam, first_seen, last_seen
             FROM vessel_identity
            WHERE name LIKE ? COLLATE NOCASE
         ORDER BY CASE
                    WHEN name = ? COLLATE NOCASE THEN 0
                    WHEN name LIKE ? COLLATE NOCASE THEN 1
                    ELSE 2
                  END, last_seen DESC
            LIMIT ?`,
        )
        .all(`%${raw}%`, raw, `${raw}%`, cap)
        .map(identityRow);
    } catch {
      return [];
    }
  }

  /**
   * The most recent stored fix for a vessel.
   *
   * readTrack() orders ascending and is meant for drawing a path, so taking
   * its first row with a limit of 1 yields the OLDEST point — the opposite of
   * "where was it last seen". This asks the database for the newest directly.
   */
  function lastFix(mmsi) {
    if (closed || !mmsi) return null;
    flush();
    try {
      const row = db
        .prepare(
          'SELECT t, lat, lon, sog, cog FROM vessel_track WHERE mmsi = ? ORDER BY t DESC LIMIT 1',
        )
        .get(String(mmsi));
      if (!row) return null;
      return {
        lat: row.lat,
        lon: row.lon,
        t: row.t,
        sog: row.sog ?? null,
        cog: row.cog ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Everything persisted about a vessel, for seeding a cold cache.
   *
   * Static AIS reports arrive only every few minutes, so after a restart a
   * hull is known by position alone — no type, no dimensions, no draught —
   * until its next static broadcast. This returns what was already learned so
   * the gap is invisible.
   *
   * Deliberately does NOT flush: it reads committed history, and flushing on
   * every newly-seen MMSI would put a transaction in the ingest hot path.
   *
   * @returns {Object|null} Static-shaped record, or null when nothing is known.
   */
  function hydrate(mmsi) {
    if (closed || !mmsi) return null;
    try {
      const id = selectIdentity.get(String(mmsi));
      const voyage = db
        .prepare(
          `SELECT destination, eta, draught FROM vessel_voyage
            WHERE mmsi = ? AND (destination IS NOT NULL OR draught > 0)
         ORDER BY observed DESC LIMIT 1`,
        )
        .get(String(mmsi));
      if (!id && !voyage) return null;
      return {
        name: id?.name || '',
        type: id?.type || '',
        imo: id?.imo || '',
        callSign: id?.call_sign || '',
        length: id?.length ?? null,
        beam: id?.beam ?? null,
        destination: voyage?.destination || '',
        eta: voyage?.eta || '',
        draught: voyage?.draught ?? null,
      };
    } catch {
      return null;
    }
  }

  function identityRow(row) {
    return {
      mmsi: row.mmsi,
      imo: row.imo || '',
      name: row.name || '',
      callSign: row.call_sign || '',
      type: row.type || '',
      length: row.length ?? null,
      beam: row.beam ?? null,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    };
  }

  function stats() {
    try {
      const tracks =
        db.prepare('SELECT COUNT(*) AS n FROM vessel_track').get()?.n ?? 0;
      const vessels =
        db.prepare('SELECT COUNT(*) AS n FROM vessel_identity').get()?.n ?? 0;
      const voyages =
        db.prepare('SELECT COUNT(*) AS n FROM vessel_voyage').get()?.n ?? 0;
      return {
        tracks,
        vessels,
        voyages,
        writes,
        flushes,
        retentionDays,
        dbPath,
      };
    } catch {
      return {
        tracks: 0,
        vessels: 0,
        voyages: 0,
        writes,
        flushes,
        retentionDays,
        dbPath,
      };
    }
  }

  const timer = setInterval(flush, flushMs);
  // The flush timer must never be the reason the process stays alive.
  timer.unref?.();

  function close() {
    if (closed) return;
    flush();
    closed = true;
    clearInterval(timer);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }

  return {
    disabled: false,
    dbPath,
    retentionDays,
    queuePosition,
    queueVoyage,
    queueIdentity,
    flush,
    prune,
    readTrack,
    readVoyages,
    readIdentity,
    searchIdentities,
    lastFix,
    hydrate,
    draughtExtremes,
    stats,
    close,
  };
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
