/**
 * @module platform/db
 *
 * The platform's Postgres connection. Optional: without GEV_DATABASE_URL the
 * app runs exactly as before and the platform routes report `configured:false`.
 *
 * `pg` is imported on first use, so an install that never sets the variable
 * never loads the driver.
 */

/** @param {NodeJS.ProcessEnv} [env] */
export function platformConfigured(env = process.env) {
  return Boolean(String(env.GEV_DATABASE_URL ?? '').trim());
}

/**
 * A URL with its password replaced, safe for logs and error text.
 * @param {string} url
 */
export function redactDatabaseUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable database url)';
  }
}

let sharedPool = null;

/**
 * The shared pool, created on first use.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{Pool?: Function}} [driver] Injected for tests.
 */
export async function getPool(env = process.env, driver) {
  if (!platformConfigured(env)) return null;
  if (sharedPool && !driver) return sharedPool;
  const Pool = driver?.Pool ?? (await import('pg')).default.Pool;
  const pool = new Pool({
    connectionString: env.GEV_DATABASE_URL,
    max: Number(env.GEV_DATABASE_POOL_MAX) || 5,
    // A dead database must fail a request quickly, not hang the dev server.
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    application_name: 'gods-eye-view',
  });
  // An idle client erroring (server restart) must not crash the process.
  pool.on('error', (error) =>
    console.warn('[Platform] idle client error:', error.message),
  );
  if (!driver) sharedPool = pool;
  return pool;
}

export async function closePool() {
  const pool = sharedPool;
  sharedPool = null;
  await pool?.end();
}
