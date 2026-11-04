import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const COLUMNS = 'ts, id, layer, lat, lon, alt, heading, speed';

/** Adds an area test; a box with west above east crosses the antimeridian. */
function addBox(where, args, bbox) {
  if (!bbox) return;
  if (bbox.west <= bbox.east) {
    where.push('lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?');
    args.push(bbox.south, bbox.north, bbox.west, bbox.east);
  } else {
    where.push('lat BETWEEN ? AND ? AND (lon >= ? OR lon <= ?)');
    args.push(bbox.south, bbox.north, bbox.west, bbox.east);
  }
}

/**
 * SQLite position history. `file` may be ':memory:'. The folder is created
 * unless `createFolder` is false, which is how a folder on another drive is
 * opened: a drive that is not plugged in must not leave a stray folder on the
 * main disk, so a missing folder is an error there.
 */
export function openHistoryStore(file, { createFolder = true } = {}) {
  if (file !== ':memory:') {
    if (createFolder) mkdirSync(path.dirname(file), { recursive: true });
    else if (!existsSync(path.dirname(file)))
      throw new Error(`Folder not found: ${path.dirname(file)}`);
  }
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS positions(
      ts INTEGER NOT NULL, id TEXT NOT NULL, layer TEXT NOT NULL,
      lat REAL NOT NULL, lon REAL NOT NULL, alt REAL, heading REAL, speed REAL);
    CREATE INDEX IF NOT EXISTS positions_ts ON positions(ts);
    CREATE INDEX IF NOT EXISTS positions_id_ts ON positions(id, ts);
    CREATE INDEX IF NOT EXISTS positions_layer_ts ON positions(layer, ts);
    CREATE TABLE IF NOT EXISTS fences(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      west REAL NOT NULL, south REAL NOT NULL, east REAL NOT NULL, north REAL NOT NULL,
      layers TEXT NOT NULL DEFAULT '', created_ts INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS fence_events(
      ts INTEGER NOT NULL, fence_id INTEGER NOT NULL, id TEXT NOT NULL,
      layer TEXT NOT NULL, kind TEXT NOT NULL, lat REAL, lon REAL);
    CREATE INDEX IF NOT EXISTS fence_events_ts ON fence_events(ts);
    CREATE TABLE IF NOT EXISTS pins(id TEXT PRIMARY KEY, created_ts INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS contacts(
      layer TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      last_seen INTEGER NOT NULL, PRIMARY KEY(layer, id));
    CREATE INDEX IF NOT EXISTS contacts_name ON contacts(name);
    CREATE TABLE IF NOT EXISTS alerts(
      ts INTEGER NOT NULL, code TEXT NOT NULL, severity TEXT NOT NULL,
      id TEXT NOT NULL, layer TEXT NOT NULL, name TEXT NOT NULL,
      lat REAL, lon REAL, detail TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS alerts_ts ON alerts(ts);
    CREATE TABLE IF NOT EXISTS feed_events(
      ts INTEGER NOT NULL, layer TEXT NOT NULL, state TEXT NOT NULL,
      detail TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS feed_events_layer_ts ON feed_events(layer, ts);`);
  const insert = db.prepare(
    `INSERT INTO positions(${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    insertMany(points) {
      db.exec('BEGIN');
      try {
        for (const p of points)
          insert.run(
            p.ts,
            p.id,
            p.layer,
            p.lat,
            p.lon,
            p.alt,
            p.heading,
            p.speed,
          );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    /** Callsigns and ship names, so a contact can be found by what it is called. */
    upsertContacts(contacts) {
      const stmt = db.prepare(
        `INSERT INTO contacts(layer, id, name, last_seen) VALUES (?, ?, ?, ?)
         ON CONFLICT(layer, id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
      );
      db.exec('BEGIN');
      try {
        for (const c of contacts) stmt.run(c.layer, c.id, c.name, c.ts);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    /** Contacts whose id or name contains `query`: exact, then prefix, then newest. */
    findContacts(query, limit = 20) {
      const term = String(query ?? '')
        .trim()
        .toLowerCase()
        .slice(0, 64);
      if (!term) return [];
      const escaped = term.replace(/[!%_]/g, (c) => `!${c}`);
      return db
        .prepare(
          `SELECT layer, id, name, last_seen FROM contacts
           WHERE lower(id) LIKE ? ESCAPE '!' OR lower(name) LIKE ? ESCAPE '!'
           ORDER BY (lower(id) = ? OR lower(name) = ?) DESC,
                    (lower(id) LIKE ? ESCAPE '!' OR lower(name) LIKE ? ESCAPE '!') DESC,
                    last_seen DESC LIMIT ?`,
        )
        .all(
          `%${escaped}%`,
          `%${escaped}%`,
          term,
          term,
          `${escaped}%`,
          `${escaped}%`,
          limit,
        );
    },
    /**
     * Keeps one position per contact per `bucket` seconds for everything
     * before `before`; pinned contacts are left alone. With `dryRun` it only
     * counts what would go. Returns { removed, total }.
     */
    thinOld({ before, bucket, dryRun = false }) {
      const total = db.prepare('SELECT COUNT(*) AS n FROM positions').get().n;
      const where = `ts < ? AND id NOT IN (SELECT id FROM pins) AND rowid NOT IN (
        SELECT MIN(rowid) FROM positions WHERE ts < ?
        GROUP BY layer, id, CAST(ts / CAST(? AS INTEGER) AS INTEGER))`;
      const args = [before, before, bucket];
      if (dryRun)
        return {
          removed: Number(
            db
              .prepare(`SELECT COUNT(*) AS n FROM positions WHERE ${where}`)
              .get(...args).n,
          ),
          total: Number(total),
        };
      const removed = db
        .prepare(`DELETE FROM positions WHERE ${where}`)
        .run(...args).changes;
      return { removed: Number(removed), total: Number(total) };
    },
    /**
     * Writes a compact copy of the whole database to `target`, which must not
     * exist. SQLite does this in one safe step, even while recording.
     */
    copyTo(target) {
      db.prepare('VACUUM INTO ?').run(target);
    },
    /** Number of saved positions per layer. */
    layerCounts() {
      return Object.fromEntries(
        db
          .prepare('SELECT layer, COUNT(*) AS n FROM positions GROUP BY layer')
          .all()
          .map((r) => [r.layer, Number(r.n)]),
      );
    },
    range() {
      return db
        .prepare(
          'SELECT MIN(ts) AS from_ts, MAX(ts) AS to_ts, COUNT(*) AS count FROM positions',
        )
        .get();
    },
    track(id, from, to) {
      return db
        .prepare(
          `SELECT ${COLUMNS} FROM positions WHERE id = ? AND ts BETWEEN ? AND ? ORDER BY ts`,
        )
        .all(id, from, to);
    },
    window({ from, to, bbox, layers, limit = 200000 }) {
      const where = ['ts BETWEEN ? AND ?'];
      const args = [from, to];
      addBox(where, args, bbox);
      if (layers?.length) {
        where.push(`layer IN (${layers.map(() => '?').join(',')})`);
        args.push(...layers);
      }
      return db
        .prepare(
          `SELECT ${COLUMNS} FROM positions WHERE ${where.join(' AND ')} ORDER BY id, ts LIMIT ?`,
        )
        .all(...args, limit);
    },
    /**
     * How many different contacts were seen in each square of a grid, over a
     * period. A square is `cell` degrees wide; (gx, gy) count from -180, -90.
     */
    density({ from, to, bbox, layers, cell, limit = 20000 }) {
      const where = ['ts BETWEEN ? AND ?'];
      const args = [from, to];
      addBox(where, args, bbox);
      if (layers?.length) {
        where.push(`layer IN (${layers.map(() => '?').join(',')})`);
        args.push(...layers);
      }
      return db
        .prepare(
          `SELECT CAST((lon + 180) / ? AS INTEGER) AS gx,
                  CAST((lat + 90) / ? AS INTEGER) AS gy,
                  COUNT(DISTINCT layer || ':' || id) AS n
           FROM positions WHERE ${where.join(' AND ')}
           GROUP BY gx, gy ORDER BY n DESC LIMIT ?`,
        )
        .all(cell, cell, ...args, limit);
    },
    /** Latest position per contact at or before `time`, no older than `lookback` s. */
    at({ time, lookback = 600, bbox, layers, limit = 50000 }) {
      const where = ['ts BETWEEN ? AND ?'];
      const args = [time - lookback, time];
      addBox(where, args, bbox);
      if (layers?.length) {
        where.push(`layer IN (${layers.map(() => '?').join(',')})`);
        args.push(...layers);
      }
      return db
        .prepare(
          `SELECT ${COLUMNS} FROM positions p WHERE ${where.join(' AND ')}
           AND ts = (SELECT MAX(ts) FROM positions q
                     WHERE q.id = p.id AND q.layer = p.layer AND q.ts <= ?)
           LIMIT ?`,
        )
        .all(...args, time, limit);
    },
    addFence(f, createdTs) {
      const r = db
        .prepare(
          'INSERT INTO fences(name, west, south, east, north, layers, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          f.name,
          f.west,
          f.south,
          f.east,
          f.north,
          f.layers.join(','),
          createdTs,
        );
      return Number(r.lastInsertRowid);
    },
    listFences() {
      return db
        .prepare('SELECT * FROM fences ORDER BY id')
        .all()
        .map((f) => ({ ...f, layers: f.layers ? f.layers.split(',') : [] }));
    },
    removeFence(id) {
      return Number(
        db.prepare('DELETE FROM fences WHERE id = ?').run(id).changes,
      );
    },
    addEvents(events) {
      const stmt = db.prepare(
        'INSERT INTO fence_events(ts, fence_id, id, layer, kind, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      db.exec('BEGIN');
      try {
        for (const e of events)
          stmt.run(e.ts, e.fence_id, e.id, e.layer, e.kind, e.lat, e.lon);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    events({ since = 0, fenceId = null, limit = 200 } = {}) {
      const where = fenceId == null ? '' : 'AND e.fence_id = ?';
      return db
        .prepare(
          `SELECT e.*, f.name AS fence, c.name AS name FROM fence_events e
           LEFT JOIN fences f ON f.id = e.fence_id
           LEFT JOIN contacts c ON c.layer = e.layer AND c.id = e.id
           WHERE e.ts >= ? ${where} ORDER BY e.ts DESC LIMIT ?`,
        )
        .all(...[since, ...(fenceId == null ? [] : [fenceId]), limit]);
    },
    /** Changes in how a feed was doing: failing, empty, idle, or ok again. */
    addFeedEvents(list) {
      const stmt = db.prepare(
        'INSERT INTO feed_events(ts, layer, state, detail) VALUES (?, ?, ?, ?)',
      );
      db.exec('BEGIN');
      try {
        for (const e of list) stmt.run(e.ts, e.layer, e.state, e.detail ?? '');
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    /** One layer's feed changes in a period, oldest first, led by the one in force at its start. */
    feedEvents({ layer, from, to }) {
      const before = db
        .prepare(
          'SELECT * FROM feed_events WHERE layer = ? AND ts < ? ORDER BY ts DESC LIMIT 1',
        )
        .all(layer, from);
      const within = db
        .prepare(
          'SELECT * FROM feed_events WHERE layer = ? AND ts BETWEEN ? AND ? ORDER BY ts',
        )
        .all(layer, from, to);
      return [...before, ...within];
    },
    /** Emergency squawk alerts, newest first. */
    addAlerts(list) {
      const stmt = db.prepare(
        'INSERT INTO alerts(ts, code, severity, id, layer, name, lat, lon, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      db.exec('BEGIN');
      try {
        for (const a of list)
          stmt.run(
            a.ts,
            a.code,
            a.severity,
            a.id,
            a.layer,
            a.name,
            a.lat,
            a.lon,
            a.detail,
          );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    alerts({ since = 0, limit = 200 } = {}) {
      return db
        .prepare('SELECT * FROM alerts WHERE ts >= ? ORDER BY ts DESC LIMIT ?')
        .all(since, limit);
    },
    /** Bytes of live data in the file (free pages excluded). */
    usedBytes() {
      const n = (sql) => Object.values(db.prepare(sql).get())[0];
      return (
        (n('PRAGMA page_count') - n('PRAGMA freelist_count')) *
        n('PRAGMA page_size')
      );
    },
    /** Deletes the oldest `fraction` of positions; returns how many. */
    dropOldest(fraction) {
      const total = db.prepare('SELECT COUNT(*) AS n FROM positions').get().n;
      const cut = Math.max(1, Math.floor(total * fraction));
      return Number(
        db
          .prepare(
            `DELETE FROM positions WHERE rowid IN
             (SELECT rowid FROM positions
              WHERE id NOT IN (SELECT id FROM pins) ORDER BY ts LIMIT ?)`,
          )
          .run(cut).changes,
      );
    },
    purgeBefore(ts) {
      db.prepare('DELETE FROM fence_events WHERE ts < ?').run(ts);
      db.prepare('DELETE FROM alerts WHERE ts < ?').run(ts);
      db.prepare('DELETE FROM feed_events WHERE ts < ?').run(ts);
      db.prepare(
        'DELETE FROM contacts WHERE last_seen < ? AND id NOT IN (SELECT id FROM pins)',
      ).run(ts);
      return Number(
        db
          .prepare(
            'DELETE FROM positions WHERE ts < ? AND id NOT IN (SELECT id FROM pins)',
          )
          .run(ts).changes,
      );
    },
    /** Pinned contacts keep their history past retention and the size cap. */
    addPin(id, createdTs) {
      db.prepare(
        'INSERT OR IGNORE INTO pins(id, created_ts) VALUES (?, ?)',
      ).run(id, createdTs);
    },
    removePin(id) {
      return Number(
        db.prepare('DELETE FROM pins WHERE id = ?').run(id).changes,
      );
    },
    listPins() {
      return db.prepare('SELECT id, created_ts FROM pins ORDER BY id').all();
    },
    close() {
      db.close();
    },
  };
}

/**
 * Stands in for a store whose folder is not there (an unplugged drive). Reads
 * answer with nothing, so the panel still works; writes fail, so the recorder
 * keeps what it has buffered and tries to open the real store again.
 */
export function createUnavailableStore(message) {
  const empty = {
    range: { from_ts: null, to_ts: null, count: 0 },
    layerCounts: {},
    usedBytes: 0,
    listFences: [],
    listPins: [],
    track: [],
    window: [],
    at: [],
    density: [],
    events: [],
    alerts: [],
    feedEvents: [],
    findContacts: [],
  };
  return new Proxy(
    {},
    {
      get: (_, name) => {
        if (name === 'close') return () => {};
        if (name === 'then') return undefined;
        return Object.hasOwn(empty, name)
          ? () => structuredClone(empty[name])
          : () => {
              throw new Error(message);
            };
      },
    },
  );
}
