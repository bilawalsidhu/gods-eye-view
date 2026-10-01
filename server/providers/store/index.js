import path from 'node:path';
import fs from 'node:fs';
import { createStore } from './store.js';
import { sqliteDriver, pgDriver } from './drivers.js';

/**
 * Process-wide store selection.
 *
 * GEV_DATABASE_URL set   -> Postgres (hosted profile; needs the `pg` package)
 * otherwise              -> SQLite at GEV_DATA_DIR (default `.gev-data/`)
 *
 * The store opens lazily on first use so a checkout that never touches
 * history features never creates a database file.
 */

let opening = null;
let testOverride = null;

export function storeConfig(env = process.env, root = process.cwd()) {
  if (env.GEV_DATABASE_URL)
    return { kind: 'postgres', url: env.GEV_DATABASE_URL };
  const dir = path.resolve(root, env.GEV_DATA_DIR || '.gev-data');
  return { kind: 'sqlite', dir, file: path.join(dir, 'history.sqlite') };
}

async function open(config) {
  if (config.kind === 'postgres') {
    let pg;
    try {
      pg = await import('pg');
    } catch {
      throw new Error(
        'GEV_DATABASE_URL is set but the `pg` package is not installed (npm i pg)',
      );
    }
    const Pool = pg.default?.Pool ?? pg.Pool;
    const pool = new Pool({ connectionString: config.url, max: 8 });
    const store = createStore(pgDriver(pool));
    await store.init();
    return store;
  }
  fs.mkdirSync(config.dir, { recursive: true });
  const store = createStore(await sqliteDriver(config.file));
  await store.init();
  return store;
}

/** @returns {Promise<object>} The shared store. */
export function getStore() {
  if (testOverride) return Promise.resolve(testOverride);
  if (!opening) {
    opening = open(storeConfig()).catch((error) => {
      opening = null;
      throw error;
    });
  }
  return opening;
}

/** Test hook: substitute a store (or null to clear). */
export function _setStoreForTest(store) {
  testOverride = store;
}

/** Close the shared store (server shutdown). */
export async function closeStore() {
  const p = opening;
  opening = null;
  if (p) {
    try {
      (await p).close();
    } catch {
      // already closed or never opened
    }
  }
}
