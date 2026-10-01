#!/usr/bin/env node
/**
 * Hosted-profile entry point.
 *
 *   npm run build && npm run start:hosted
 *
 * Required: GEV_AUTH_MODE (tokens|supabase), GEV_SESSION_SECRET (32+ chars)
 * and that mode's settings (see docs/HOSTED.md). Recommended:
 * GEV_DATABASE_URL (Postgres) so history survives redeploys.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localProviderPlugins } from './providers/local.js';
import { createHostedServer } from './hosted/server.js';
import { closeStore } from './providers/store/index.js';
import { stopHistoryRuntime } from './providers/history/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));

// Licensing-sensitive packs default off when hosted (see DATA_SOURCES.md).
process.env.CCTV_DELDOT_ENABLED ??= '0';
process.env.GEV_PROFILE = 'hosted';

let server;
try {
  server = createHostedServer({
    env: process.env,
    distDir: process.env.GEV_DIST_DIR || path.join(root, 'dist'),
    plugins: localProviderPlugins(),
  });
} catch (error) {
  console.error(`[hosted] refusing to start: ${error.message}`);
  process.exit(1);
}

const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => {
  console.log(`[hosted] God's Eye View listening on http://${host}:${port}`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[hosted] ${signal}: shutting down`);
  server.close();
  server.closeAllConnections?.();
  await stopHistoryRuntime().catch(() => {});
  await closeStore().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
