import { admitSameSiteKeyless } from '../providers/common/same-site.js';
import { getPool, platformConfigured } from './db.js';
import { loadMigrations } from './migrate.js';

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * What the platform database looks like right now.
 *
 * Never throws and never echoes a connection string or a driver message that
 * could carry one: a failure is reported as `ok:false` with a short reason.
 *
 * @param {{env?: NodeJS.ProcessEnv, pool?: object}} [options]
 */
export async function platformStatus({ env = process.env, pool } = {}) {
  if (!platformConfigured(env)) return { configured: false, ok: false };
  try {
    const db = pool ?? (await getPool(env));
    const [migrations, version, postgis, current] = await Promise.all([
      loadMigrations(),
      db.query('SHOW server_version'),
      db.query("SELECT extversion FROM pg_extension WHERE extname = 'postgis'"),
      db
        .query('SELECT max(version) AS v FROM public.gev_migration')
        .catch(() => ({ rows: [{ v: null }] })),
    ]);
    const applied = Number(current.rows[0]?.v ?? 0);
    return {
      configured: true,
      ok: true,
      server: version.rows[0]?.server_version ?? null,
      postgis: postgis.rows[0]?.extversion ?? null,
      migrationsApplied: applied,
      migrationsAvailable: migrations.length,
      upToDate: applied === migrations.length,
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      reason: String(error?.code || error?.name || 'error'),
    };
  }
}

/**
 * Vite plugin: `GET /api/platform/health`. Same-site only, read-only.
 * @param {{env?: NodeJS.ProcessEnv, pool?: object}} [options]
 * @returns {import('vite').Plugin}
 */
export function platformProxy(options = {}) {
  async function handle(req, res) {
    if (admitSameSiteKeyless(req, res)) return;
    const path = String(req.url || '').split('?')[0];
    if (req.method !== 'GET' || (path !== '/health' && path !== '/health/')) {
      sendJson(res, 404, { error: 'Unknown platform route' });
      return;
    }
    sendJson(res, 200, await platformStatus(options));
  }
  function install(server) {
    server.middlewares.use('/api/platform', (req, res) => {
      void handle(req, res);
    });
  }
  return {
    name: 'platform-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
