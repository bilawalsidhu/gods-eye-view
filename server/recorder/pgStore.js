const CHUNK = 5000;
const COLUMNS = 'ts, id, layer, lat, lon, alt, heading, speed';

/**
 * PostgreSQL history store with the same methods as the SQLite one, every call
 * returning a promise. PostGIS is used when the server has it (a point column
 * with a GiST index for area queries); plain PostgreSQL works without it.
 * The `pg` package is loaded on first use, so it is only needed when
 * GEV_HISTORY_DB is set. `loadPg` exists so tests can supply a stand-in.
 */
export function createPgStore(url, { loadPg = () => import('pg') } = {}) {
  let pool = null;
  let postgis = false;

  const ready = (async () => {
    let pg;
    try {
      const mod = await loadPg();
      pg = mod.default ?? mod;
    } catch {
      throw new Error(
        'GEV_HISTORY_DB needs the "pg" package: run  npm install pg',
      );
    }
    pool = new pg.Pool({
      connectionString: url,
      max: 4,
      // bigint columns (timestamps, counts) come back as numbers.
      types: {
        getTypeParser: (oid, format) =>
          oid === 20 ? Number : pg.types.getTypeParser(oid, format),
      },
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS positions(
        ts BIGINT NOT NULL, id TEXT NOT NULL, layer TEXT NOT NULL,
        lat DOUBLE PRECISION NOT NULL, lon DOUBLE PRECISION NOT NULL,
        alt DOUBLE PRECISION, heading DOUBLE PRECISION, speed DOUBLE PRECISION);
      CREATE INDEX IF NOT EXISTS positions_ts ON positions(ts);
      CREATE INDEX IF NOT EXISTS positions_id_ts ON positions(id, ts);
      CREATE INDEX IF NOT EXISTS positions_layer_ts ON positions(layer, ts);
      CREATE TABLE IF NOT EXISTS fences(
        id SERIAL PRIMARY KEY, name TEXT NOT NULL,
        west DOUBLE PRECISION NOT NULL, south DOUBLE PRECISION NOT NULL,
        east DOUBLE PRECISION NOT NULL, north DOUBLE PRECISION NOT NULL,
        layers TEXT NOT NULL DEFAULT '', created_ts BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS fence_events(
        ts BIGINT NOT NULL, fence_id INTEGER NOT NULL, id TEXT NOT NULL,
        layer TEXT NOT NULL, kind TEXT NOT NULL,
        lat DOUBLE PRECISION, lon DOUBLE PRECISION);
      CREATE INDEX IF NOT EXISTS fence_events_ts ON fence_events(ts);
      CREATE TABLE IF NOT EXISTS pins(
        id TEXT PRIMARY KEY, created_ts BIGINT NOT NULL);`);
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
      await pool.query(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS geom
        geometry(Point, 4326) GENERATED ALWAYS AS
        (ST_SetSRID(ST_MakePoint(lon, lat), 4326)) STORED`);
      await pool.query(
        'CREATE INDEX IF NOT EXISTS positions_geom ON positions USING GIST(geom)',
      );
      postgis = true;
    } catch {
      postgis = false;
    }
  })();
  // A failed start is reported by the first call, not as an unhandled rejection.
  ready.catch(() => {});

  const query = async (text, params = []) => {
    await ready;
    return pool.query(text, params);
  };
  const rows = async (text, params) => (await query(text, params)).rows;

  /** Builds a WHERE list, numbering parameters as they are added. */
  function filters() {
    const args = [];
    const where = [];
    const add = (value) => {
      args.push(value);
      return `$${args.length}`;
    };
    return {
      args,
      where,
      add,
      bbox(box, usePostgis) {
        if (!box) return;
        // West above east means the box crosses the antimeridian.
        if (box.west > box.east) {
          where.push(
            `lat BETWEEN ${add(box.south)} AND ${add(box.north)} AND (lon >= ${add(box.west)} OR lon <= ${add(box.east)})`,
          );
          return;
        }
        where.push(
          usePostgis
            ? `geom && ST_MakeEnvelope(${add(box.west)}, ${add(box.south)}, ${add(box.east)}, ${add(box.north)}, 4326)`
            : `lat BETWEEN ${add(box.south)} AND ${add(box.north)} AND lon BETWEEN ${add(box.west)} AND ${add(box.east)}`,
        );
      },
      layers(list) {
        if (list?.length) where.push(`layer = ANY(${add(list)}::text[])`);
      },
    };
  }

  async function insertColumns(table, names, types, items) {
    for (let i = 0; i < items.length; i += CHUNK) {
      const part = items.slice(i, i + CHUNK);
      await query(
        `INSERT INTO ${table}(${names.join(', ')})
         SELECT * FROM unnest(${types.map((t, n) => `$${n + 1}::${t}[]`).join(', ')})`,
        names.map((name) => part.map((item) => item[name] ?? null)),
      );
    }
  }

  return {
    insertMany: (points) =>
      insertColumns(
        'positions',
        ['ts', 'id', 'layer', 'lat', 'lon', 'alt', 'heading', 'speed'],
        [
          'bigint',
          'text',
          'text',
          'float8',
          'float8',
          'float8',
          'float8',
          'float8',
        ],
        points,
      ),
    async layerCounts() {
      return Object.fromEntries(
        (
          await rows(
            'SELECT layer, COUNT(*) AS n FROM positions GROUP BY layer',
          )
        ).map((r) => [r.layer, Number(r.n)]),
      );
    },
    async range() {
      const [r] = await rows(
        'SELECT MIN(ts) AS from_ts, MAX(ts) AS to_ts, COUNT(*) AS count FROM positions',
      );
      return r;
    },
    track: (id, from, to) =>
      rows(
        `SELECT ${COLUMNS} FROM positions WHERE id = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts`,
        [id, from, to],
      ),
    async window({ from, to, bbox, layers, limit = 200000 }) {
      await ready;
      const f = filters();
      f.where.push(`ts BETWEEN ${f.add(from)} AND ${f.add(to)}`);
      f.bbox(bbox, postgis);
      f.layers(layers);
      return rows(
        `SELECT ${COLUMNS} FROM positions WHERE ${f.where.join(' AND ')}
         ORDER BY id, ts LIMIT ${f.add(limit)}`,
        f.args,
      );
    },
    /** Latest position per contact at or before `time`, no older than `lookback` s. */
    async at({ time, lookback = 600, bbox, layers, limit = 50000 }) {
      const inner = filters();
      inner.where.push(
        `ts BETWEEN ${inner.add(time - lookback)} AND ${inner.add(time)}`,
      );
      inner.layers(layers);
      // The latest fix is chosen first, then tested against the box, so a
      // contact that has left the box is not reported at an older position.
      const outer = { where: [] };
      if (bbox) {
        const n = inner.args.length;
        inner.args.push(bbox.south, bbox.north, bbox.west, bbox.east);
        outer.where.push(
          bbox.west <= bbox.east
            ? `lat BETWEEN $${n + 1} AND $${n + 2} AND lon BETWEEN $${n + 3} AND $${n + 4}`
            : `lat BETWEEN $${n + 1} AND $${n + 2} AND (lon >= $${n + 3} OR lon <= $${n + 4})`,
        );
      }
      return rows(
        `SELECT ${COLUMNS} FROM (
           SELECT DISTINCT ON (id, layer) ${COLUMNS} FROM positions
           WHERE ${inner.where.join(' AND ')} ORDER BY id, layer, ts DESC) latest
         ${outer.where.length ? `WHERE ${outer.where.join(' AND ')}` : ''}
         LIMIT ${inner.args.push(limit) && `$${inner.args.length}`}`,
        inner.args,
      );
    },
    async addFence(f, createdTs) {
      const [r] = await rows(
        `INSERT INTO fences(name, west, south, east, north, layers, created_ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          f.name,
          f.west,
          f.south,
          f.east,
          f.north,
          f.layers.join(','),
          createdTs,
        ],
      );
      return Number(r.id);
    },
    async listFences() {
      return (await rows('SELECT * FROM fences ORDER BY id')).map((f) => ({
        ...f,
        layers: f.layers ? f.layers.split(',') : [],
      }));
    },
    async removeFence(id) {
      return (await query('DELETE FROM fences WHERE id = $1', [id])).rowCount;
    },
    addEvents: (events) =>
      insertColumns(
        'fence_events',
        ['ts', 'fence_id', 'id', 'layer', 'kind', 'lat', 'lon'],
        ['bigint', 'integer', 'text', 'text', 'text', 'float8', 'float8'],
        events,
      ),
    events({ since = 0, fenceId = null, limit = 200 } = {}) {
      const f = filters();
      f.where.push(`e.ts >= ${f.add(since)}`);
      if (fenceId != null) f.where.push(`e.fence_id = ${f.add(fenceId)}`);
      return rows(
        `SELECT e.*, f.name AS fence FROM fence_events e
         LEFT JOIN fences f ON f.id = e.fence_id
         WHERE ${f.where.join(' AND ')} ORDER BY e.ts DESC LIMIT ${f.add(limit)}`,
        f.args,
      );
    },
    async addPin(id, createdTs) {
      await query(
        'INSERT INTO pins(id, created_ts) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, createdTs],
      );
    },
    async removePin(id) {
      return (await query('DELETE FROM pins WHERE id = $1', [id])).rowCount;
    },
    listPins: () => rows('SELECT id, created_ts FROM pins ORDER BY id'),
    async usedBytes() {
      const [r] = await rows("SELECT pg_total_relation_size('positions') AS n");
      return Number(r.n);
    },
    async dropOldest(fraction) {
      const [{ n }] = await rows('SELECT COUNT(*) AS n FROM positions');
      const cut = Math.max(1, Math.floor(n * fraction));
      return (
        await query(
          `DELETE FROM positions WHERE ctid IN (
             SELECT ctid FROM positions
             WHERE id NOT IN (SELECT id FROM pins) ORDER BY ts LIMIT $1)`,
          [cut],
        )
      ).rowCount;
    },
    async purgeBefore(ts) {
      await query('DELETE FROM fence_events WHERE ts < $1', [ts]);
      return (
        await query(
          'DELETE FROM positions WHERE ts < $1 AND id NOT IN (SELECT id FROM pins)',
          [ts],
        )
      ).rowCount;
    },
    async close() {
      try {
        await ready;
      } catch {
        return;
      }
      await pool.end();
    },
  };
}
