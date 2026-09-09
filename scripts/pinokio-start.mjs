#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPinokioEnvironment } from './pinokio-environment.mjs';
import { isDirectInvocation } from './pinokio-install.mjs';
import { validatePinokioSharing } from './pinokio-preflight.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const ROOT = realpathSync(path.resolve(path.dirname(MODULE_PATH), '..'));

function launchPort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Pinokio did not supply a valid local port.');
  }
  return port;
}

export async function loadViteFromCanonicalRoot(
  root = ROOT,
  loadVite = () => import('vite'),
) {
  process.chdir(realpathSync(path.resolve(root)));
  return loadVite();
}

async function start() {
  applyPinokioEnvironment();
  validatePinokioSharing();
  const port = launchPort(process.env.PORT);
  // Provider Settings routes credential writes to pinokio/ENVIRONMENT (never
  // .env) when the app runs under this launcher. The marker is set here — after
  // applyPinokioEnvironment, before Vite snapshots process.env — so the
  // dev-server endpoint knows which store this launch owns.
  process.env.GEV_LAUNCHER = 'pinokio';
  console.log('[Pinokio] Local-only launch.');

  // Import Vite only after app-scoped blank fields have replaced any merged
  // Pinokio-global values. Vite snapshots process.env during configuration.
  const { createServer } = await loadViteFromCanonicalRoot();
  const server = await createServer({
    root: ROOT,
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
    },
  });
  await server.listen();
  server.printUrls();
  console.log(`[Pinokio] Ready at http://127.0.0.1:${port}/`);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await server.close();
      process.exit(0);
    });
  }
}

if (isDirectInvocation(process.argv[1], MODULE_PATH)) {
  start().catch((error) => {
    console.error(`[Pinokio] Start refused: ${error.message}`);
    process.exitCode = 1;
  });
}
