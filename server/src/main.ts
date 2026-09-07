import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { buildApp } from './app.js';
import { createServiceAdapters } from './adapters/index.js';
import { loadConfig } from './config.js';
import { loadCompatibilityBridge } from './compatibility.js';
import { ReadinessState } from './readiness.js';

const mode = process.env.NODE_ENV?.trim() || 'development';
for (const filename of [`.env.${mode}.local`, '.env.local', `.env.${mode}`, '.env']) {
  if (existsSync(filename)) loadEnvFile(filename);
}
await import('./telemetry.js');

const config = loadConfig();
const readiness = new ReadinessState();
const compatibilityBridge = await loadCompatibilityBridge(config);
const adapters = createServiceAdapters(config);
const app = await buildApp({
  config,
  adapters,
  readiness,
  compatibilityBridge,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  readiness.markNotReady('draining');
  app.log.info({ signal }, 'shutdown started');

  const hardStop = setTimeout(() => {
    app.log.error({ graceMs: config.shutdownGraceMs }, 'shutdown deadline exceeded');
    process.exit(1);
  }, config.shutdownGraceMs);
  hardStop.unref();

  try {
    await app.close();
    await compatibilityBridge.close?.();
    clearTimeout(hardStop);
    app.log.info('shutdown complete');
  } catch (error) {
    clearTimeout(hardStop);
    app.log.error({ err: error }, 'shutdown failed');
    process.exitCode = 1;
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  readiness.markNotReady('startup-failed');
  app.log.fatal({ err: error }, 'server startup failed');
  process.exitCode = 1;
}
