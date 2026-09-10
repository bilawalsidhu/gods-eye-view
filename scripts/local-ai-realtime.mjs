import { spawn as spawnProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const LOCAL_AI_REALTIME_URL_DEFAULT = 'http://localhost:8080/v1/realtime/calls';
export const LOCAL_AI_REALTIME_MODEL_DEFAULT = 'gpt-realtime';
export const LOCAL_AI_READY_TIMEOUT_MS = 180_000;

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
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
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
} = {}) {
  let child = null;
  let startedAt = 0;
  let lastError = null;
  let preloadPromise = null;
  let preloadedModel = null;

  const realtimeUrl = () => environment.GEV_LOCAL_REALTIME_URL || LOCAL_AI_REALTIME_URL_DEFAULT;
  const modelName = () => environment.GEV_LOCAL_REALTIME_MODEL || LOCAL_AI_REALTIME_MODEL_DEFAULT;
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

  async function preload(model) {
    if (preloadedModel === model) return true;
    if (preloadPromise) return preloadPromise;
    preloadPromise = (async () => {
      const response = await fetchImpl(`${origin()}/backend/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(readyTimeoutMs),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || body?.message || `Pipeline preload failed (${response.status})`);
      }
      preloadedModel = model;
      return true;
    })().finally(() => {
      preloadPromise = null;
    });
    return preloadPromise;
  }

  async function start() {
    if (await reachable()) return { started: false, reason: 'already-running' };
    preloadedModel = null;
    if (isChildRunning()) return { started: false, reason: 'starting' };
    if (!isLoopbackOrigin(origin())) return { started: false, reason: 'remote-target' };

    const executable = environment.GEV_LOCAL_AI_BIN || 'local-ai';
    const home = environment.GEV_LOCAL_AI_HOME || path.join(homeDirectory, '.local', 'share', 'localai');
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
        spawned.once('spawn', () => finish({ started: true, reason: 'spawned' }));
        spawned.once('error', (error) => {
          lastError = error?.code === 'ENOENT'
            ? `${executable} not found on PATH — install it or set GEV_LOCAL_AI_BIN`
            : error?.message || String(error);
          if (child === spawned) child = null;
          finish({ started: false, reason: error?.code === 'ENOENT' ? 'missing-binary' : 'spawn-failed' });
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

  async function status({ startRequested = false } = {}) {
    const model = modelName();
    if (startRequested) {
      const result = await start();
      if (result.reason === 'missing-binary' || result.reason === 'spawn-failed') {
        return { state: 'unavailable', detail: lastError || 'Could not start the local backend', model, origin: origin() };
      }
      if (result.reason === 'remote-target') {
        return { state: 'unavailable', detail: `${origin()} is remote — start LocalAI on that host`, model, origin: origin() };
      }
    }

    if (!(await reachable())) {
      if (isChildRunning()) {
        const elapsedMs = now() - startedAt;
        if (elapsedMs > readyTimeoutMs) {
          return {
            state: 'unavailable',
            detail: `Local backend did not come up within ${Math.round(readyTimeoutMs / 1000)}s`,
            model,
            origin: origin(),
          };
        }
        return { state: 'starting', detail: `Starting local backend… ${Math.round(elapsedMs / 1000)}s`, model, origin: origin() };
      }
      return { state: 'stopped', detail: lastError || 'Local backend is not running', model, origin: origin() };
    }

    if (!(await pipelineReady(model))) {
      const starting = isChildRunning() && now() - startedAt <= readyTimeoutMs;
      return {
        state: starting ? 'starting' : 'unavailable',
        detail: starting ? `Loading "${model}" pipeline…` : `LocalAI does not have the "${model}" pipeline`,
        model,
        origin: origin(),
      };
    }
    try {
      await preload(model);
      return { state: 'ready', detail: 'Local voice pipeline loaded', model, origin: origin() };
    } catch (error) {
      lastError = error?.message || String(error);
      return { state: 'unavailable', detail: `Local voice pipeline failed to load: ${lastError}`, model, origin: origin() };
    }
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
    let model = modelName();
    try {
      model = new URL(req.url || '', 'http://localhost').searchParams.get('model') || model;
    } catch {
      // Keep the configured model for a malformed relative request URL.
    }
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
        res.end(raw || JSON.stringify({ error: `Local realtime endpoint HTTP ${upstream.status}` }));
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
        res.end(JSON.stringify({ error: 'Local realtime endpoint returned no SDP answer' }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/sdp');
      res.end(answerSdp);
    } catch (error) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: `Local voice backend unreachable at ${realtimeUrl()} — is it running? (${error?.message || error})`,
      }));
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
