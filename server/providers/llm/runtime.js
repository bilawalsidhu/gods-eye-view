import { spawn, execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Starting and stopping a local model server from the app.
 *
 * This is the one endpoint in the project that executes a binary, so the
 * envelope is deliberately narrow:
 *
 *   - The binary is never named by the caller. It is resolved from PATH by
 *     provider id, so a request can ask for "llamacpp", not for a path.
 *   - A model must match one the server itself discovered. The caller sends an
 *     identifier that is compared against that list; an unmatched value is
 *     refused rather than passed on.
 *   - Arguments are an array handed to spawn(). No shell is involved at any
 *     point, so no quoting or interpolation can turn data into a command.
 *   - Only the child this module started can be stopped. An arbitrary PID is
 *     not something a caller can express.
 *
 * The route in front of this reuses the Provider Settings admission gate:
 * loopback only, no proxy headers, refused while the server is shared.
 */

const SPAWN_READY_TIMEOUT_MS = 120000;
const LOG_LINES = 40;

/** Supported runtimes. `probe` is what proves the server is up. */
const RUNTIMES = Object.freeze({
  ollama: {
    binary: 'ollama',
    defaultPort: 11434,
    // Ollama binds its own port and takes no model at launch; models load on
    // first use, so a start is just `serve`.
    args: () => ['serve'],
    probePath: '/api/tags',
    modelKind: 'name',
  },
  llamacpp: {
    binary: 'llama-server',
    defaultPort: 8080,
    args: ({ modelPath, port }) => [
      '-m',
      modelPath,
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
    ],
    probePath: '/v1/models',
    modelKind: 'path',
  },
});

/** Process-scoped handle for the child this module owns. */
let _child = null;
let _meta = null;
const _log = [];

/** Whether the app may launch processes at all. */
export function spawnEnabled(env = process.env) {
  const raw = String(env.GEV_LLM_ALLOW_SPAWN ?? '')
    .trim()
    .toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

/**
 * Directories searched for GGUF files.
 * `GEV_LLM_MODEL_DIR` takes a colon-separated list; otherwise a few
 * conventional locations are tried and missing ones simply skipped.
 */
export function modelDirectories(env = process.env) {
  const configured = String(env.GEV_LLM_MODEL_DIR ?? '').trim();
  if (configured) {
    return configured
      .split(':')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map(expandHome);
  }
  const home = os.homedir();
  return [
    path.join(home, 'models'),
    path.join(home, '.cache', 'llama.cpp'),
    path.join(home, '.local', 'share', 'models'),
  ];
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

/** Resolves a binary on PATH without a shell. Returns '' when absent. */
export function whichBinary(name, { execImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execImpl('/usr/bin/which', [name], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve('');
      resolve(
        String(stdout || '')
          .trim()
          .split('\n')[0] || '',
      );
    });
  });
}

/** Whether a runtime is installed, and where. */
export async function detectRuntime(provider, options = {}) {
  const runtime = RUNTIMES[provider];
  if (!runtime)
    return {
      provider,
      installed: false,
      binary: '',
      error: 'unknown provider',
    };
  const binary = await whichBinary(runtime.binary, options);
  return {
    provider,
    installed: Boolean(binary),
    binary,
    defaultPort: runtime.defaultPort,
    modelKind: runtime.modelKind,
  };
}

/**
 * Models this machine can actually load.
 *
 * llama.cpp takes a file, so the answer is whatever GGUF files exist in the
 * configured directories. Ollama manages its own store, so it is asked.
 *
 * @returns {Promise<Array<{id:string,label:string,path?:string,sizeBytes?:number}>>}
 */
export async function discoverLocalModels(provider, options = {}) {
  if (provider === 'llamacpp') return discoverGgufModels(options);
  if (provider === 'ollama') return discoverOllamaModels(options);
  return [];
}

async function discoverGgufModels({ env = process.env, maxDepth = 3 } = {}) {
  const found = [];
  const seen = new Set();
  for (const root of modelDirectories(env)) {
    await walkForGguf(root, maxDepth, found, seen);
  }
  found.sort((a, b) => a.label.localeCompare(b.label));
  return found;
}

async function walkForGguf(directory, depth, found, seen) {
  if (depth < 0 || found.length >= 200) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return; // missing or unreadable directories are simply not searched
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkForGguf(full, depth - 1, found, seen);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.gguf'))
      continue;
    // Multi-part shards: only the first part is passed to llama-server, which
    // finds the rest itself. Offering part 2 would fail to load.
    if (/-0000[2-9]-of-\d+\.gguf$/i.test(entry.name)) continue;
    if (seen.has(full)) continue;
    seen.add(full);
    let sizeBytes = null;
    try {
      sizeBytes = (await stat(full)).size;
    } catch {
      /* size is cosmetic */
    }
    found.push({
      id: full,
      label: entry.name.replace(/\.gguf$/i, ''),
      path: full,
      sizeBytes,
    });
  }
}

async function discoverOllamaModels({ execImpl = execFile } = {}) {
  const binary = await whichBinary('ollama', { execImpl });
  if (!binary) return [];
  return new Promise((resolve) => {
    execImpl(binary, ['list'], { timeout: 10000 }, (error, stdout) => {
      if (error) return resolve([]);
      const lines = String(stdout || '')
        .trim()
        .split('\n')
        .slice(1);
      const models = [];
      for (const line of lines) {
        const name = line.trim().split(/\s+/)[0];
        if (name) models.push({ id: name, label: name });
      }
      resolve(models);
    });
  });
}

/**
 * Reports a server on a provider's port that this process did not start —
 * typically one launched before the dev server last restarted, or by hand in
 * a terminal. It is surfaced rather than hidden so the panel never offers to
 * start a second copy on an occupied port.
 */
export async function detectExternalServer(provider, options = {}) {
  const runtime = RUNTIMES[provider];
  if (!runtime) return null;
  const port = normalizePort(options.port, runtime.defaultPort);
  if (!port) return null;
  const fetchImpl =
    options.fetchImpl || ((...args) => globalThis.fetch(...args));
  try {
    const response = await fetchImpl(
      `http://127.0.0.1:${port}${runtime.probePath}`,
      { signal: AbortSignal.timeout(1500) },
    );
    if (!response.ok) return null;
    return { provider, port, managed: false };
  } catch {
    return null;
  }
}

/** The child this module owns, if any. */
export function runtimeState() {
  const running = Boolean(_child && _child.exitCode === null && !_child.killed);
  return {
    running,
    provider: running ? _meta?.provider : null,
    model: running ? _meta?.model : null,
    modelLabel: running ? _meta?.modelLabel : null,
    port: running ? _meta?.port : null,
    pid: running ? _child.pid : null,
    startedAt: running ? _meta?.startedAt : null,
    managed: running,
    log: _log.slice(-LOG_LINES),
  };
}

function record(line) {
  for (const part of String(line).split('\n')) {
    const text = part.trim();
    if (text) _log.push(text);
  }
  while (_log.length > LOG_LINES * 4) _log.shift();
}

/**
 * Starts a local model server.
 *
 * @param {{provider:string, model?:string, port?:number}} request
 * @returns {Promise<{ok:boolean, error?:string, state:Object}>}
 */
export async function startRuntime(request = {}, options = {}) {
  const env = options.env || process.env;
  if (!spawnEnabled(env)) {
    return {
      ok: false,
      error: 'Launching local servers is disabled (GEV_LLM_ALLOW_SPAWN=0)',
      state: runtimeState(),
    };
  }
  if (_child && _child.exitCode === null) {
    return {
      ok: false,
      error: 'A model server is already running — stop it first',
      state: runtimeState(),
    };
  }

  const provider = String(request.provider || '').trim();
  const runtime = RUNTIMES[provider];
  if (!runtime)
    return {
      ok: false,
      error: `Unsupported provider: ${provider}`,
      state: runtimeState(),
    };

  const detected = await detectRuntime(provider, options);
  if (!detected.installed) {
    return {
      ok: false,
      error:
        provider === 'ollama'
          ? 'ollama is not installed or not on PATH'
          : 'llama-server is not installed or not on PATH',
      state: runtimeState(),
    };
  }

  const port = normalizePort(request.port, runtime.defaultPort);
  if (!port)
    return {
      ok: false,
      error: 'Port must be between 1024 and 65535',
      state: runtimeState(),
    };

  // The caller names a model; the server decides whether that name is one it
  // offered. An unmatched value never reaches the command line.
  let chosen = null;
  if (runtime.modelKind === 'path') {
    const available = await discoverLocalModels(provider, options);
    chosen = available.find(
      (entry) => entry.id === String(request.model || ''),
    );
    if (!chosen) {
      return {
        ok: false,
        error: available.length
          ? 'Choose one of the discovered models'
          : `No .gguf files found in ${modelDirectories(env).join(', ')} — set GEV_LLM_MODEL_DIR`,
        state: runtimeState(),
      };
    }
  }

  const args = runtime.args({ modelPath: chosen?.path, port });
  _log.length = 0;
  record(`$ ${detected.binary} ${args.join(' ')}`);

  let child;
  try {
    child = spawn(detected.binary, args, {
      // No shell: arguments stay arguments, whatever they contain.
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detached, because saving settings restarts the dev server and a model
      // that took a minute to load should not die with it. The tradeoff is an
      // orphan if the app is killed outright, which is why an unmanaged
      // server on the port is still detected and reported below.
      detached: true,
      env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}` },
    });
    child.unref();
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      state: runtimeState(),
    };
  }

  _child = child;
  _meta = {
    provider,
    model: chosen?.id || request.model || '',
    modelLabel: chosen?.label || request.model || '',
    port,
    startedAt: Date.now(),
  };
  child.stdout?.on('data', (chunk) => record(chunk.toString()));
  child.stderr?.on('data', (chunk) => record(chunk.toString()));
  child.on('exit', (code, signal) => {
    record(`process exited (code ${code}, signal ${signal || 'none'})`);
    if (_child === child) {
      _child = null;
      _meta = null;
    }
  });

  const ready = await waitForReady(
    `http://127.0.0.1:${port}${runtime.probePath}`,
    options,
    child,
  );
  if (!ready.ok) {
    // A server that never answered is not a running server; leave nothing
    // half-alive for the next request to trip over.
    await stopRuntime();
    return { ok: false, error: ready.error, state: runtimeState() };
  }
  return { ok: true, state: runtimeState() };
}

/** Polls until the server answers, it exits, or the deadline passes. */
async function waitForReady(url, options = {}, child) {
  const fetchImpl =
    options.fetchImpl || ((...args) => globalThis.fetch(...args));
  const deadline =
    Date.now() + (options.readyTimeoutMs ?? SPAWN_READY_TIMEOUT_MS);
  const sleep =
    options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      return {
        ok: false,
        error: `Server exited immediately: ${_log.slice(-3).join(' | ')}`,
      };
    }
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) return { ok: true };
    } catch {
      /* not up yet */
    }
    await sleep(750);
  }
  return {
    ok: false,
    error: 'Server did not become ready in time — check the log',
  };
}

/** Stops the child this module started. Never touches anything else. */
export async function stopRuntime(options = {}) {
  const child = _child;
  if (!child || child.exitCode !== null) {
    _child = null;
    _meta = null;
    return { ok: true, state: runtimeState() };
  }
  const sleep =
    options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  child.kill('SIGTERM');
  for (let i = 0; i < 20 && child.exitCode === null; i += 1) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
  _child = null;
  _meta = null;
  return { ok: true, state: runtimeState() };
}

function normalizePort(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const port = Number.parseInt(String(value), 10);
  if (!Number.isFinite(port) || port < 1024 || port > 65535) return 0;
  return port;
}

/** Test seam. */
export function resetRuntimeForTesting() {
  _child = null;
  _meta = null;
  _log.length = 0;
}
