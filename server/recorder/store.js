import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const COLUMNS = 'ts, id, layer, lat, lon, alt, heading, speed';

/** SQLite position history. `file` may be ':memory:'. */
export function openHistoryStore(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
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
    CREATE INDEX IF NOT EXISTS fence_events_ts ON fence_events(ts);`);
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
      if (bbox) {
        where.push('lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?');
        args.push(bbox.south, bbox.north, bbox.west, bbox.east);
      }
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
    /** Latest position per contact at or before `time`, no older than `lookback` s. */
    at({ time, lookback = 600, bbox, layers, limit = 50000 }) {
      const where = ['ts BETWEEN ? AND ?'];
      const args = [time - lookback, time];
      if (bbox) {
        where.push('lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?');
        args.push(bbox.south, bbox.north, bbox.west, bbox.east);
      }
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
          `SELECT e.*, f.name AS fence FROM fence_events e
           LEFT JOIN fences f ON f.id = e.fence_id
           WHERE e.ts >= ? ${where} ORDER BY e.ts DESC LIMIT ?`,
        )
        .all(...[since, ...(fenceId == null ? [] : [fenceId]), limit]);
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
             (SELECT rowid FROM positions ORDER BY ts LIMIT ?)`,
          )
          .run(cut).changes,
      );
    },
    purgeBefore(ts) {
      db.prepare('DELETE FROM fence_events WHERE ts < ?').run(ts);
      return Number(
        db.prepare('DELETE FROM positions WHERE ts < ?').run(ts).changes,
      );
    },
    close() {
      db.close();
    },
  };
}
