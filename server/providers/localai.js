import { spawn as spawnProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { incompleteDownloadBytes } from './localai/files.js';
import {
  LOCAL_AI_REALTIME_MODEL_DEFAULT,
  LOCAL_AI_REALTIME_URL_DEFAULT,
} from './localai/constants.js';

export { incompleteDownloadBytes } from './localai/files.js';
export {
  LOCAL_AI_REALTIME_MODEL_DEFAULT,
  LOCAL_AI_REALTIME_URL_DEFAULT,
} from './localai/constants.js';
const LOCAL_AI_READY_TIMEOUT_MS = 180_000;
/** How long a warm-up may make NO measurable progress before it counts as failed. */
const LOCAL_AI_STALL_TIMEOUT_MS = 45_000;
/** A first run downloads gigabytes, so the load request itself gets a long leash. */
const LOCAL_AI_PRELOAD_TIMEOUT_MS = 30 * 60_000;

function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function localAiOrigin(realtimeUrl = LOCAL_AI_REALTIME_URL_DEFAULT) {
  try {
    return new URL(realtimeUrl).origin;
  } catch {
    return new URL(LOCAL_AI_REALTIME_URL_DEFAULT).origin;
  }
}

export function isLoopbackOrigin(origin) {
  try {
    const host = new URL(origin).hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]'
    );
  } catch {
    return false;
  }
}

/**
 * Owns one optional LocalAI child plus the two same-origin HTTP routes used by
 * the browser. Dependencies are injectable so process and network behavior can
 * be covered without launching models in the unit suite.
 */
export function createLocalAiRealtime({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawnProcess,
  homeDirectory = os.homedir(),
  now = Date.now,
  readyTimeoutMs = LOCAL_AI_READY_TIMEOUT_MS,
  stallTimeoutMs = LOCAL_AI_STALL_TIMEOUT_MS,
  preloadTimeoutMs = LOCAL_AI_PRELOAD_TIMEOUT_MS,
  readyGraceMs = 1_500,
  configGraceMs = 15_000,
  downloadedBytes = null,
} = {}) {
  let child = null;
  let startedAt = 0;
  let lastError = null;
  let preloadPromise = null;
  let preloadedModel = null;
  let preloadError = null;
  let progressMark = '';
  let progressAt = 0;

  const localAiHome = () =>
    environment.GEV_LOCAL_AI_HOME ||
    path.join(homeDirectory, '.local', 'share', 'localai');
  const pendingBytes = () =>
    downloadedBytes
      ? downloadedBytes()
      : incompleteDownloadBytes(path.join(localAiHome(), 'models'));
  /** Seconds since the warm-up last changed state; resets whenever it moves. */
  const sinceProgress = (mark) => {
    if (mark !== progressMark || progressAt === 0) {
      progressMark = mark;
      progressAt = now();
    }
    return now() - progressAt;
  };
  const grace = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer?.unref?.();
    });

  const realtimeUrl = () =>
    environment.GEV_LOCAL_REALTIME_URL || LOCAL_AI_REALTIME_URL_DEFAULT;
  const modelName = () =>
    environment.GEV_LOCAL_REALTIME_MODEL || LOCAL_AI_REALTIME_MODEL_DEFAULT;
  const origin = () => localAiOrigin(realtimeUrl());
  const isChildRunning = () => child && child.exitCode === null;

  async function reachable(timeoutMs = 2000) {
    try {
      const response = await fetchImpl(`${origin()}/v1/models`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function pipelineReady(model) {
    try {
      const response = await fetchImpl(`${origin()}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return false;
      const body = await response.json();
      return (body?.data || []).some((entry) => entry?.id === model);
    } catch {
      return false;
    }
  }

  /**
   * Ask LocalAI to load the pipeline. The request blocks for as long as the
   * load takes — minutes on a first run that still has to download weights —
   * so callers race it against a short grace period instead of waiting on it.
   */
  function preload(model) {
    if (preloadedModel === model) return Promise.resolve(true);
    if (preloadPromise) return preloadPromise;
    preloadError = null;
    const attempt = (async () => {
      const response = await fetchImpl(`${origin()}/backend/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(preloadTimeoutMs),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          body?.error ||
            body?.message ||
            `Pipeline preload failed (${response.status})`,
        );
      }
      preloadedModel = model;
      return true;
    })();
    preloadPromise = attempt;
    // The racing caller may walk away; keep the rejection from going unhandled
    // and remember it so the next poll can report it.
    void attempt.then(
      () => {
        if (preloadPromise === attempt) preloadPromise = null;
      },
      (error) => {
        preloadError = error?.message || String(error);
        if (preloadPromise === attempt) preloadPromise = null;
      },
    );
    return attempt;
  }

  async function start() {
    if (await reachable()) {
      // A POST is an explicit retry. Once a failed preload has settled, let a
      // new session try it again without requiring a dev-server restart.
      if (!preloadPromise && preloadError) {
        preloadError = null;
        progressMark = '';
        progressAt = 0;
      }
      return { started: false, reason: 'already-running' };
    }
    preloadedModel = null;
    preloadError = null;
    progressMark = '';
    progressAt = 0;
    if (isChildRunning()) return { started: false, reason: 'starting' };
    if (!isLoopbackOrigin(origin()))
      return { started: false, reason: 'remote-target' };

    const executable = environment.GEV_LOCAL_AI_BIN || 'local-ai';
    const home =
      environment.GEV_LOCAL_AI_HOME ||
      path.join(homeDirectory, '.local', 'share', 'localai');
    const port = new URL(origin()).port || '8080';

    try {
      // spawn resolves PATH itself. Keeping shell:false avoids command
      // concatenation and accepts absolute GEV_LOCAL_AI_BIN paths as-is.
      const spawned = spawnImpl(executable, ['run', `--address=:${port}`], {
        cwd: home,
        env: {
          ...environment,
          LOCALAI_MODELS_PATH: path.join(home, 'models'),
          LOCALAI_BACKENDS_PATH: path.join(home, 'backends'),
        },
        detached: false,
        shell: false,
        stdio: 'ignore',
      });
      child = spawned;
      startedAt = now();
      lastError = null;

      return await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        spawned.once('spawn', () =>
          finish({ started: true, reason: 'spawned' }),
        );
        spawned.once('error', (error) => {
          lastError =
            error?.code === 'ENOENT'
              ? `${executable} not found on PATH — install it or set GEV_LOCAL_AI_BIN`
              : error?.message || String(error);
          if (child === spawned) child = null;
          finish({
            started: false,
            reason:
              error?.code === 'ENOENT' ? 'missing-binary' : 'spawn-failed',
          });
        });
        spawned.once('exit', (code) => {
          if (code) lastError = `local-ai exited with code ${code}`;
          preloadedModel = null;
          if (child === spawned) child = null;
        });
      });
    } catch (error) {
      lastError = error?.message || String(error);
      child = null;
      return { started: false, reason: 'spawn-failed' };
    }
  }

  /**
   * One honest answer per poll, and never a blocking one.
   *
   * A first LOCAL session may have to download gigabytes of weights, so the
   * warm-up reports which phase it is in — booting, downloading, loading — and
   * gives up only when that phase stops moving. A wall-clock cutoff would fail
   * a healthy download on a slow link and then succeed on the next click, which
   * reads as random. States: ready | starting | needs-setup | unavailable |
   * stopped, where needs-setup always names the command that fixes it.
   */
  async function status({ startRequested = false } = {}) {
    const model = modelName();
    const at = (state, detail) => ({ state, detail, model, origin: origin() });

    if (startRequested) {
      const result = await start();
      if (result.reason === 'missing-binary') {
        return at(
          'needs-setup',
          'LocalAI is not installed — run: brew install localai, then npm run voice:local:setup',
        );
      }
      if (result.reason === 'spawn-failed') {
        return at(
          'unavailable',
          lastError || 'Could not start the local backend',
        );
      }
      if (result.reason === 'remote-target') {
        return at(
          'unavailable',
          `${origin()} is remote — start LocalAI on that host`,
        );
      }
    }

    if (!(await reachable())) {
      if (!isChildRunning())
        return at('stopped', lastError || 'Local backend is not running');
      const elapsedMs = now() - startedAt;
      if (elapsedMs > readyTimeoutMs) {
        return at(
          'unavailable',
          `Local backend did not answer within ${Math.round(readyTimeoutMs / 1000)}s`,
        );
      }
      return at(
        'starting',
        `Starting local backend… ${Math.round(elapsedMs / 1000)}s`,
      );
    }

    if (!(await pipelineReady(model))) {
      // LocalAI serves HTTP before it finishes reading model configs, so only
      // call the profile missing once that window has passed.
      if (isChildRunning() && now() - startedAt < configGraceMs) {
        return at(
          'starting',
          `Starting local backend… ${Math.round((now() - startedAt) / 1000)}s`,
        );
      }
      return at(
        'needs-setup',
        `LocalAI has no "${model}" pipeline — run npm run voice:local:setup`,
      );
    }

    if (preloadError)
      return at(
        'unavailable',
        `Local voice pipeline failed to load: ${preloadError}`,
      );
    await Promise.race([
      preload(model).catch(() => false),
      grace(readyGraceMs),
    ]);
    if (preloadedModel === model)
      return at('ready', 'Local voice pipeline loaded');
    if (preloadError)
      return at(
        'unavailable',
        `Local voice pipeline failed to load: ${preloadError}`,
      );

    const bytes = pendingBytes();
    if (bytes > 0) {
      const stalledMs = sinceProgress(`download:${bytes}`);
      if (stalledMs > stallTimeoutMs) {
        return at(
          'unavailable',
          'Model download stalled — check the connection, then choose LOCAL again',
        );
      }
      return at(
        'starting',
        `Downloading model weights… ${Math.round(bytes / 1e6)} MB so far (first run only)`,
      );
    }
    const loadingMs = sinceProgress('load');
    if (loadingMs > readyTimeoutMs) {
      return at(
        'unavailable',
        `Local voice pipeline did not load within ${Math.round(readyTimeoutMs / 1000)}s`,
      );
    }
    return at(
      'starting',
      `Loading speech, language and voice models… ${Math.round(loadingMs / 1000)}s`,
    );
  }

  async function backendRoute(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    const result = await status({ startRequested: req.method === 'POST' });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(result));
  }

  async function callsRoute(req, res) {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    // The server configuration owns the pipeline id. A browser or LAN caller
    // cannot use this relay to select and load another installed model.
    const model = modelName();
    try {
      const offer = await readRequestBody(req, 1024 * 1024);
      const upstream = await fetchImpl(realtimeUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: offer, model }),
        signal: AbortSignal.timeout(30_000),
      });
      const raw = await upstream.text();
      if (!upstream.ok) {
        res.statusCode = upstream.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          raw ||
            JSON.stringify({
              error: `Local realtime endpoint HTTP ${upstream.status}`,
            }),
        );
        return;
      }
      let answerSdp = '';
      try {
        answerSdp = JSON.parse(raw)?.sdp || '';
      } catch {
        answerSdp = raw;
      }
      if (!answerSdp) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: 'Local realtime endpoint returned no SDP answer',
          }),
        );
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/sdp');
      res.end(answerSdp);
    } catch (error) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: `Local voice backend unreachable at ${realtimeUrl()} — is it running? (${error?.message || error})`,
        }),
      );
    }
  }

  function install(middlewares) {
    middlewares.use('/api/realtime/local-backend', backendRoute);
    middlewares.use('/api/realtime/local-calls', callsRoute);
  }

  function dispose() {
    if (!isChildRunning()) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Best effort during dev-server shutdown.
    }
  }

  return { install, dispose, status, start, callsRoute, backendRoute };
}

/** Vite provider for LocalAI lifecycle, status, and WebRTC signalling. */
export function localAiRealtimeProxy(options = {}) {
  const localAi = createLocalAiRealtime(options);
  const configure = (server) => {
    localAi.install(server.middlewares);
    server.httpServer?.on('close', localAi.dispose);
  };
  return {
    name: 'localai-realtime-proxy',
    configureServer: configure,
    configurePreviewServer: configure,
    closeBundle: localAi.dispose,
  };
}
