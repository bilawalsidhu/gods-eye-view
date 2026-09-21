import {
  detectRuntime,
  discoverLocalModels,
  runtimeState,
  detectExternalServer,
  startRuntime,
  stopRuntime,
  spawnEnabled,
  modelDirectories,
} from './runtime.js';

/**
 * Request handler for /api/llm/runtime.
 *
 * GET  → what is installed, what models exist, and whether we started a server.
 * POST → {action: 'start'|'stop', provider, model, port}.
 *
 * The admission gate is supplied by the caller so this stays testable and so
 * the policy lives in one place with Provider Settings.
 */
export function createLlmRuntimeHandler({
  admit = () => ({ ok: true }),
  env = process.env,
  ...options
} = {}) {
  return async function handle(req, res) {
    const verdict = admit(req);
    if (!verdict?.ok) {
      return send(res, verdict?.status || 403, {
        error: verdict?.error || 'Refused',
      });
    }

    if (req.method === 'GET') {
      return send(res, 200, await snapshot(env, options));
    }
    if (req.method !== 'POST') {
      return send(res, 405, { error: 'Use GET or POST' });
    }

    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return send(res, 400, { error: String(error?.message || error) });
    }

    const action = String(body?.action || '').trim();
    if (action === 'stop') {
      const result = await stopRuntime(options);
      return send(res, 200, { ...result, ...(await snapshot(env, options)) });
    }
    if (action !== 'start') {
      return send(res, 400, { error: "action must be 'start' or 'stop'" });
    }

    const result = await startRuntime(
      { provider: body?.provider, model: body?.model, port: body?.port },
      { ...options, env },
    );
    return send(res, result.ok ? 200 : 409, {
      ...result,
      ...(await snapshot(env, options)),
    });
  };
}

/** Everything the panel needs to render the controls. */
async function snapshot(env, options) {
  const state = runtimeState();
  const providers = {};
  // A server left listening from before a restart is still a running server.
  let external = null;
  if (!state.running) {
    for (const provider of ['llamacpp', 'ollama']) {
      external = await detectExternalServer(provider, options);
      if (external) break;
    }
  }
  for (const provider of ['ollama', 'llamacpp']) {
    const detected = await detectRuntime(provider, options);
    providers[provider] = {
      ...detected,
      models: detected.installed
        ? await discoverLocalModels(provider, { ...options, env })
        : [],
    };
  }
  return {
    spawnAllowed: spawnEnabled(env),
    modelDirs: modelDirectories(env),
    runtime: external
      ? { ...state, running: true, managed: false, ...external }
      : state,
    providers,
  };
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** Reads a small JSON body. Caps the size so a request cannot exhaust memory. */
function readJson(req, limitBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}
