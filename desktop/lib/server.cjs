'use strict';

const net = require('node:net');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const PREFERRED_PORT = 47831;
const PORT_ATTEMPTS = 25;
const READY_PATTERN = /\[GEV\] Ready at (http:\/\/127\.0\.0\.1:\d+\/)/;
// First launch optimizes Cesium and friends; allow for a slow disk.
const START_TIMEOUT_MS = 180_000;

/** Whether a loopback port can be bound right now. */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * Prefer a stable port so the browser origin (and therefore localStorage:
 * language, first-run state, layer choices) survives restarts; fall back to
 * the next free port when something else holds it.
 */
async function pickPort(
  preferred = PREFERRED_PORT,
  attempts = PORT_ATTEMPTS,
  isFree = portIsFree,
) {
  for (let offset = 0; offset < attempts; offset += 1) {
    if (await isFree(preferred + offset)) return preferred + offset;
  }
  throw new Error(
    `No free local port between ${preferred} and ${preferred + attempts - 1}`,
  );
}

/** Extract the served URL from one chunk of server output, or null. */
function parseReadyUrl(chunk) {
  const match = READY_PATTERN.exec(String(chunk));
  return match ? match[1] : null;
}

/**
 * Start the local application server in a child Node process and resolve once
 * it reports its URL. The child exits by itself when this process goes away
 * (IPC disconnect), and stop() ends it deliberately.
 * @param {{paths: ReturnType<import('./paths.cjs').resolvePaths>, logger: ReturnType<import('./logger.cjs').createLogger>, port?: number}} options
 * @returns {Promise<{url: string, stop: () => void, onExit: (cb: (code: number|null) => void) => void}>}
 */
async function startServer({ paths, logger, port }) {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.cacheDir, { recursive: true });
  const chosen = port ?? (await pickPort());
  logger.info(`starting server on 127.0.0.1:${chosen}`);
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(chosen),
    GEV_LAUNCHER: 'desktop',
    GEV_STATE_DIR: paths.stateDir,
    GEV_CACHE_DIR: paths.cacheDir,
    GEV_PAYLOAD_ROOT: paths.payloadRoot,
  };
  // The child is a plain Node, never an Electron-as-Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(paths.nodeBinary, [paths.serveScript], {
    cwd: paths.payloadRoot,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env,
  });
  const exitListeners = [];
  let exited = false;
  child.once('exit', (code) => {
    exited = true;
    logger.info(`server exited with code ${code}`);
    for (const listener of exitListeners) listener(code);
  });

  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error('The local server did not start in time.')),
      START_TIMEOUT_MS,
    );
    const finish = (fn, value) => {
      clearTimeout(timer);
      fn(value);
    };
    const onData = (chunk) => {
      logger.raw(chunk);
      output = (output + chunk).slice(-4096);
      const ready = parseReadyUrl(output);
      if (ready) finish(resolve, ready);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => logger.raw(chunk));
    child.once('error', (error) => finish(reject, error));
    child.once('exit', (code) =>
      finish(
        reject,
        new Error(`The local server stopped during startup (code ${code}).`),
      ),
    );
  });

  return {
    url,
    stop() {
      if (!exited) child.kill();
    },
    onExit(callback) {
      if (exited) callback(null);
      else exitListeners.push(callback);
    },
  };
}

module.exports = {
  PREFERRED_PORT,
  parseReadyUrl,
  pickPort,
  portIsFree,
  startServer,
};
