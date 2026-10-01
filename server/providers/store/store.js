/**
 * Dialect-neutral history store.
 *
 * One SQL surface runs on SQLite (local profile, node:sqlite) and Postgres
 * (hosted profile, `pg` or PGlite). A driver supplies four async calls:
 *   exec(sqlScript), run(sql, params), all(sql, params), transaction(fn).
 * Placeholders are written `?` here; the Postgres driver rewrites them.
 *
 * Owner scoping: every user-authored record (watchlists, fences, rules,
 * alerts) carries an `owner`. The local profile uses the single owner
 * 'local'; the hosted profile passes the authenticated user id.
 *
 * What is stored: positions the public feeds published, camera uptime
 * samples, and user-authored settings. Never camera imagery.
 */

export const SCHEMA_VERSION = 1;

export const FLAG_ON_GROUND = 1;
export const FLAG_PINNED = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS gev_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS fixes (
  domain TEXT NOT NULL,
  id TEXT NOT NULL,
  t BIGINT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  alt DOUBLE PRECISION,
  speed DOUBLE PRECISION,
  course DOUBLE PRECISION,
  squawk TEXT,
  flags INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS fixes_asset_t ON fixes (domain, id, t);
CREATE INDEX IF NOT EXISTS fixes_t ON fixes (t);
CREATE TABLE IF NOT EXISTS assets (
  domain TEXT NOT NULL,
  id TEXT NOT NULL,
  label TEXT,
  meta TEXT,
  first_seen BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  last_lat DOUBLE PRECISION,
  last_lon DOUBLE PRECISION,
  PRIMARY KEY (domain, id)
);
CREATE INDEX IF NOT EXISTS assets_last_seen ON assets (last_seen);
CREATE TABLE IF NOT EXISTS records (
  kind TEXT NOT NULL,
  owner TEXT NOT NULL,
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated BIGINT NOT NULL,
  PRIMARY KEY (kind, owner, id)
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  rule_id TEXT,
  t BIGINT NOT NULL,
  domain TEXT,
  asset TEXT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  acked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alerts_owner_t ON alerts (owner, t);
CREATE TABLE IF NOT EXISTS cam_samples (
  camera TEXT NOT NULL,
  t BIGINT NOT NULL,
  ok INTEGER NOT NULL,
  status TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS cam_samples_camera_t ON cam_samples (camera, t);
CREATE INDEX IF NOT EXISTS cam_samples_t ON cam_samples (t);
`;

const n = (v) => (v === null || v === undefined ? null : Number(v));
const finiteOrNull = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const clampLimit = (v, d, max) => {
  const x = Math.floor(Number(v));
  return Number.isFinite(x) && x > 0 ? Math.min(x, max) : d;
};

function bboxClause(bbox, params) {
  if (!bbox) return '';
  params.push(bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon);
  return ' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?';
}

function domainClause(domain, params, column = 'domain') {
  if (!domain) return '';
  params.push(domain);
  return ` AND ${column} = ?`;
}

function fixRow(r) {
  return {
    domain: r.domain,
    id: r.id,
    t: n(r.t),
    lat: n(r.lat),
    lon: n(r.lon),
    alt: n(r.alt),
    speed: n(r.speed),
    course: n(r.course),
    squawk: r.squawk ?? null,
    onGround: (Number(r.flags) & FLAG_ON_GROUND) !== 0,
    pinned: (Number(r.flags) & FLAG_PINNED) !== 0,
    ...(r.label !== undefined ? { label: r.label ?? null } : {}),
  };
}

function parseJson(text, fallback = null) {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Wrap a driver with the store API.
 * @param {object} driver Dialect driver.
 * @returns {object} Store.
 */
export function createStore(driver) {
  if (!driver?.run || !driver?.all || !driver?.exec || !driver?.transaction)
    throw new TypeError('store driver must provide exec/run/all/transaction');

  return {
    dialect: driver.dialect,

    async init() {
      await driver.exec(DDL);
      await driver.run(
        'INSERT INTO gev_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        ['schema_version', String(SCHEMA_VERSION)],
      );
    },

    /**
     * Insert kept fixes and refresh their assets in one transaction.
     * @param {object[]} fixes Observations with an optional `pinned` flag.
     */
    async insertFixes(fixes) {
      if (!fixes?.length) return 0;
      await driver.transaction(async (tx) => {
        for (const f of fixes) {
          const flags =
            (f.onGround === true ? FLAG_ON_GROUND : 0) |
            (f.pinned ? FLAG_PINNED : 0);
          await tx.run(
            'INSERT INTO fixes (domain, id, t, lat, lon, alt, speed, course, squawk, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              f.domain,
              f.id,
              Math.round(f.t),
              f.lat,
              f.lon,
              finiteOrNull(f.alt),
              finiteOrNull(f.speed),
              finiteOrNull(f.course),
              f.squawk ?? null,
              flags,
            ],
          );
          await tx.run(
            `INSERT INTO assets (domain, id, label, meta, first_seen, last_seen, last_lat, last_lon)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (domain, id) DO UPDATE SET
               label = COALESCE(excluded.label, assets.label),
               meta = COALESCE(excluded.meta, assets.meta),
               first_seen = CASE WHEN excluded.first_seen < assets.first_seen THEN excluded.first_seen ELSE assets.first_seen END,
               last_lat = CASE WHEN excluded.last_seen >= assets.last_seen THEN excluded.last_lat ELSE assets.last_lat END,
               last_lon = CASE WHEN excluded.last_seen >= assets.last_seen THEN excluded.last_lon ELSE assets.last_lon END,
               last_seen = CASE WHEN excluded.last_seen > assets.last_seen THEN excluded.last_seen ELSE assets.last_seen END`,
            [
              f.domain,
              f.id,
              f.label ?? null,
              f.meta ? JSON.stringify(f.meta) : null,
              Math.round(f.t),
              Math.round(f.t),
              f.lat,
              f.lon,
            ],
          );
        }
      });
      return fixes.length;
    },

    /** Fixes for one asset, oldest first. */
    async track({ domain, id, from, to, limit }) {
      const rows = await driver.all(
        'SELECT * FROM fixes WHERE domain = ? AND id = ? AND t BETWEEN ? AND ? ORDER BY t ASC LIMIT ?',
        [domain, id, from, to, clampLimit(limit, 5000, 50000)],
      );
      return rows.map(fixRow);
    },

    /** Latest fix per asset inside [at - windowMs, at], optionally in a box. */
    async snapshot({ at, windowMs = 300_000, bbox, domain, limit }) {
      const params = [at - windowMs, at];
      let where = 't BETWEEN ? AND ?';
      where += bboxClause(bbox, params);
      where += domainClause(domain, params);
      params.push(clampLimit(limit, 5000, 20000));
      const rows = await driver.all(
        `SELECT f.*, a.label AS label FROM fixes f
         JOIN (SELECT domain, id, MAX(t) AS mt FROM fixes WHERE ${where} GROUP BY domain, id) m
           ON f.domain = m.domain AND f.id = m.id AND f.t = m.mt
         LEFT JOIN assets a ON a.domain = f.domain AND a.id = f.id
         LIMIT ?`,
        params,
      );
      return rows.map(fixRow);
    },

    /** Every fix in a time range, grouped by asset (for the time machine). */
    async range({ from, to, bbox, domain, limit }) {
      const params = [from, to];
      let where = 't BETWEEN ? AND ?';
      where += bboxClause(bbox, params);
      where += domainClause(domain, params);
      params.push(clampLimit(limit, 50000, 200000));
      const rows = await driver.all(
        `SELECT domain, id, t, lat, lon, alt, speed, course, squawk, flags FROM fixes
         WHERE ${where} ORDER BY domain, id, t LIMIT ?`,
        params,
      );
      return rows.map(fixRow);
    },

    async asset(domain, id) {
      const rows = await driver.all(
        'SELECT * FROM assets WHERE domain = ? AND id = ?',
        [domain, id],
      );
      return rows[0] ? assetRow(rows[0]) : null;
    },

    async searchAssets({ q, domain, limit }) {
      const params = [];
      let where = '1 = 1';
      if (q) {
        const like = `%${String(q).toUpperCase().slice(0, 64)}%`;
        params.push(like, like);
        where += ' AND (UPPER(id) LIKE ? OR UPPER(label) LIKE ?)';
      }
      where += domainClause(domain, params);
      params.push(clampLimit(limit, 50, 500));
      const rows = await driver.all(
        `SELECT * FROM assets WHERE ${where} ORDER BY last_seen DESC LIMIT ?`,
        params,
      );
      return rows.map(assetRow);
    },

    /** Mark an asset's recent fixes as pinned (e.g. newly watchlisted). */
    async pinAsset(domain, id, since) {
      await driver.run(
        `UPDATE fixes SET flags = flags | ${FLAG_PINNED} WHERE domain = ? AND id = ? AND t >= ?`,
        [domain, id, since],
      );
    },

    /**
     * Apply retention.
     * @param {{now: number, unpinnedMs: number, pinnedMs: number,
     *   downsampleAfterMs: number, downsampleBucketMs: number,
     *   camMs: number, alertsMs: number}} p Policy.
     */
    async prune(p) {
      const out = {};
      out.unpinned = await driver.run(
        `DELETE FROM fixes WHERE t < ? AND (flags & ${FLAG_PINNED}) = 0`,
        [p.now - p.unpinnedMs],
      );
      out.pinned = await driver.run('DELETE FROM fixes WHERE t < ?', [
        p.now - p.pinnedMs,
      ]);
      const dsTo = p.now - p.downsampleAfterMs;
      const dsFrom = dsTo - 2 * 86_400_000;
      const b = Math.max(1000, Math.round(p.downsampleBucketMs));
      out.downsampled = await driver.run(
        `DELETE FROM fixes WHERE t >= ? AND t < ? AND EXISTS (
           SELECT 1 FROM fixes g WHERE g.domain = fixes.domain AND g.id = fixes.id
             AND g.t < fixes.t AND g.t >= fixes.t - (fixes.t % ${b})
             AND (g.squawk IS NOT DISTINCT FROM fixes.squawk))`,
        [dsFrom, dsTo],
      );
      out.cam = await driver.run('DELETE FROM cam_samples WHERE t < ?', [
        p.now - p.camMs,
      ]);
      out.alerts = await driver.run('DELETE FROM alerts WHERE t < ?', [
        p.now - p.alertsMs,
      ]);
      out.assets = await driver.run(
        'DELETE FROM assets WHERE last_seen < ? AND NOT EXISTS (SELECT 1 FROM fixes f WHERE f.domain = assets.domain AND f.id = assets.id)',
        [p.now - p.unpinnedMs],
      );
      return out;
    },

    async stats() {
      const [fx] = await driver.all(
        'SELECT COUNT(*) AS c, MIN(t) AS lo, MAX(t) AS hi FROM fixes',
        [],
      );
      const [as] = await driver.all('SELECT COUNT(*) AS c FROM assets', []);
      const byDomain = await driver.all(
        'SELECT domain, COUNT(*) AS c FROM fixes GROUP BY domain',
        [],
      );
      return {
        fixes: n(fx?.c) ?? 0,
        assets: n(as?.c) ?? 0,
        oldest: n(fx?.lo),
        newest: n(fx?.hi),
        byDomain: Object.fromEntries(byDomain.map((r) => [r.domain, n(r.c)])),
      };
    },

    // ---- user-authored records (watchlists, fences, rules, regions) ----
    async putRecord(kind, owner, id, body, now = Date.now()) {
      await driver.run(
        `INSERT INTO records (kind, owner, id, body, updated) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kind, owner, id) DO UPDATE SET body = excluded.body, updated = excluded.updated`,
        [kind, owner, id, JSON.stringify(body), now],
      );
    },
    async listRecords(kind, owner) {
      const params = [kind];
      let where = 'kind = ?';
      if (owner !== undefined) {
        params.push(owner);
        where += ' AND owner = ?';
      }
      const rows = await driver.all(
        `SELECT owner, id, body, updated FROM records WHERE ${where} ORDER BY updated ASC`,
        params,
      );
      return rows.map((r) => ({
        owner: r.owner,
        id: r.id,
        updated: n(r.updated),
        ...parseJson(r.body, {}),
      }));
    },
    async deleteRecord(kind, owner, id) {
      return driver.run(
        'DELETE FROM records WHERE kind = ? AND owner = ? AND id = ?',
        [kind, owner, id],
      );
    },

    // ---- alerts ----
    async insertAlert(a) {
      await driver.run(
        `INSERT INTO alerts (id, owner, rule_id, t, domain, asset, kind, severity, title, detail, lat, lon, acked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          a.id,
          a.owner,
          a.ruleId ?? null,
          Math.round(a.t),
          a.domain ?? null,
          a.asset ?? null,
          a.kind,
          a.severity,
          a.title,
          a.detail ? JSON.stringify(a.detail) : null,
          finiteOrNull(a.lat),
          finiteOrNull(a.lon),
        ],
      );
    },
    async listAlerts({ owner, since = 0, until, limit }) {
      const params = [owner, since];
      let where = 'owner = ? AND t >= ?';
      if (until !== undefined) {
        params.push(until);
        where += ' AND t <= ?';
      }
      params.push(clampLimit(limit, 200, 2000));
      const rows = await driver.all(
        `SELECT * FROM alerts WHERE ${where} ORDER BY t DESC LIMIT ?`,
        params,
      );
      return rows.map((r) => ({
        id: r.id,
        owner: r.owner,
        ruleId: r.rule_id,
        t: n(r.t),
        domain: r.domain,
        asset: r.asset,
        kind: r.kind,
        severity: r.severity,
        title: r.title,
        detail: parseJson(r.detail),
        lat: n(r.lat),
        lon: n(r.lon),
        acked: Number(r.acked) === 1,
      }));
    },
    async ackAlert(owner, id) {
      return driver.run(
        'UPDATE alerts SET acked = 1 WHERE owner = ? AND id = ?',
        [owner, id],
      );
    },

    // ---- camera uptime samples ----
    async insertCamSamples(samples) {
      if (!samples?.length) return 0;
      await driver.transaction(async (tx) => {
        for (const s of samples) {
          await tx.run(
            'INSERT INTO cam_samples (camera, t, ok, status, source) VALUES (?, ?, ?, ?, ?)',
            [
              String(s.camera),
              Math.round(s.t),
              s.ok ? 1 : 0,
              s.status ?? null,
              s.source ?? null,
            ],
          );
        }
      });
      return samples.length;
    },
    async camUptime({ from, to, camera }) {
      const params = [from, to];
      let where = 't BETWEEN ? AND ?';
      if (camera) {
        params.push(String(camera));
        where += ' AND camera = ?';
      }
      const rows = await driver.all(
        `SELECT camera, COUNT(*) AS samples, SUM(ok) AS ok, MAX(t) AS last_t
         FROM cam_samples WHERE ${where} GROUP BY camera`,
        params,
      );
      return rows.map((r) => ({
        camera: r.camera,
        samples: n(r.samples),
        ok: n(r.ok) ?? 0,
        uptime: n(r.samples) ? (n(r.ok) ?? 0) / n(r.samples) : null,
        lastSample: n(r.last_t),
      }));
    },
    async camSeries({ camera, from, to, bucketMs = 3_600_000 }) {
      const b = Math.max(60_000, Math.round(bucketMs));
      const rows = await driver.all(
        `SELECT (t - (t % ${b})) AS bucket, COUNT(*) AS samples, SUM(ok) AS ok
         FROM cam_samples WHERE camera = ? AND t BETWEEN ? AND ?
         GROUP BY (t - (t % ${b})) ORDER BY bucket ASC`,
        [String(camera), from, to],
      );
      return rows.map((r) => ({
        t: n(r.bucket),
        samples: n(r.samples),
        uptime: n(r.samples) ? (n(r.ok) ?? 0) / n(r.samples) : null,
      }));
    },

    close: () => driver.close?.(),
  };
}

function assetRow(r) {
  return {
    domain: r.domain,
    id: r.id,
    label: r.label ?? null,
    meta: parseJson(r.meta),
    firstSeen: n(r.first_seen),
    lastSeen: n(r.last_seen),
    lastLat: n(r.last_lat),
    lastLon: n(r.last_lon),
  };
}
