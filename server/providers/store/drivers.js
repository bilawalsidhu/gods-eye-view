/**
 * Store drivers.
 *
 * sqliteDriver: node:sqlite (built into Node 24), WAL mode, one connection,
 *   transactions serialized through a promise chain so overlapping async
 *   callers cannot nest BEGIN.
 * pgDriver: anything with `query(text, params) -> {rows, rowCount|affectedRows}`
 *   (a `pg` Pool or Client, or PGlite). `?` placeholders become `$n`.
 */

/**
 * @param {string} file Database path, or ':memory:'.
 * @returns {Promise<object>} Driver.
 */
export async function sqliteDriver(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(
    'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;',
  );
  const cache = new Map();
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      if (cache.size > 200) cache.clear();
      cache.set(sql, s);
    }
    return s;
  };
  const base = {
    run: async (sql, params = []) => Number(prep(sql).run(...params).changes),
    all: async (sql, params = []) => prep(sql).all(...params),
  };
  let chain = Promise.resolve();
  return {
    dialect: 'sqlite',
    exec: async (sql) => db.exec(sql),
    ...base,
    transaction(fn) {
      const next = chain.then(async () => {
        db.exec('BEGIN');
        try {
          const out = await fn(base);
          db.exec('COMMIT');
          return out;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
      chain = next.catch(() => {});
      return next;
    },
    close: () => db.close(),
  };
}

/** Rewrite `?` placeholders to `$1..$n`, skipping quoted strings. */
export function toPgPlaceholders(sql) {
  let i = 0;
  let out = '';
  let quoted = false;
  for (const ch of sql) {
    if (ch === "'") quoted = !quoted;
    if (ch === '?' && !quoted) out += `$${++i}`;
    else out += ch;
  }
  return out;
}

/**
 * @param {{query: Function, connect?: Function, exec?: Function, end?: Function, close?: Function}} client
 * @returns {object} Driver.
 */
export function pgDriver(client) {
  const wrap = (q) => ({
    run: async (sql, params = []) => {
      const r = await q(toPgPlaceholders(sql), params);
      return Number(r.rowCount ?? r.affectedRows ?? 0);
    },
    all: async (sql, params = []) =>
      (await q(toPgPlaceholders(sql), params)).rows,
  });
  const base = wrap((text, params) => client.query(text, params));
  let chain = Promise.resolve();
  return {
    dialect: 'postgres',
    exec: async (sql) => (client.exec ? client.exec(sql) : client.query(sql)),
    ...base,
    async transaction(fn) {
      // A Pool hands out a dedicated client; a single client/PGlite is
      // serialized through the chain instead.
      if (
        typeof client.connect === 'function' &&
        client.totalCount !== undefined
      ) {
        const c = await client.connect();
        try {
          await c.query('BEGIN');
          const out = await fn(wrap((t, p) => c.query(t, p)));
          await c.query('COMMIT');
          return out;
        } catch (error) {
          await c.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          c.release();
        }
      }
      const next = chain.then(async () => {
        await client.query('BEGIN');
        try {
          const out = await fn(base);
          await client.query('COMMIT');
          return out;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
      chain = next.catch(() => {});
      return next;
    },
    close: () => (client.end ? client.end() : client.close?.()),
  };
}
