'use strict';

const path = require('node:path');

/**
 * Resolve every location the desktop shell needs. Packaged builds carry the
 * application payload and a pinned Node runtime under `resources/`; a
 * development checkout (`npm start` inside desktop/) runs the repository
 * itself with the Node found on PATH.
 * @param {{isPackaged: boolean, resourcesPath?: string, userData: string, logs: string, platform?: string, env?: NodeJS.ProcessEnv}} input
 */
function resolvePaths({
  isPackaged,
  resourcesPath = '',
  userData,
  logs,
  platform = process.platform,
  env = process.env,
}) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const payloadRoot = isPackaged
    ? path.join(resourcesPath, 'app-payload')
    : repoRoot;
  const nodeBinary = isPackaged
    ? path.join(
        resourcesPath,
        'runtime',
        platform === 'win32' ? 'node.exe' : 'node',
      )
    : env.GEV_NODE || 'node';
  return Object.freeze({
    payloadRoot,
    nodeBinary,
    serveScript: isPackaged
      ? path.join(payloadRoot, 'desktop-serve.mjs')
      : path.join(repoRoot, 'desktop', 'runtime', 'serve.mjs'),
    // The writable .env store (provider keys) and Vite's dependency cache live
    // in the per-user data directory so upgrades never touch them.
    stateDir: path.join(userData, 'config'),
    cacheDir: path.join(userData, 'cache', 'vite'),
    logDir: logs,
    windowStateFile: path.join(userData, 'window-state.json'),
  });
}

module.exports = { resolvePaths };
