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
    CREATE INDEX IF NOT EXISTS positions_layer_ts ON positions(layer, ts);`);
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
    purgeBefore(ts) {
      return Number(
        db.prepare('DELETE FROM positions WHERE ts < ?').run(ts).changes,
      );
    },
    close() {
      db.close();
    },
  };
}
