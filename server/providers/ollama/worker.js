import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** Names that never reach the worker: provider keys, tokens, passwords. */
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL/i;

/**
 * Environment handed to the Python worker: everything except secret-shaped
 * names. The worker only needs PATH, CUDA, cache and its own WHISPER_* /
 * TTS_* / PIPER_* / SPEAKER_* settings; provider keys and tokens stay in the
 * Node process (a Whisper crash dump or a rogue model download must not carry
 * them). HF_TOKEN goes too: every model the worker loads is public.
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {Record<string, string>}
 */
export function workerEnvironment(source = process.env) {
  const scrubbed = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || SECRET_ENV_NAME.test(name)) continue;
    scrubbed[name] = value;
  }
  return scrubbed;
}

/**
 * Supervise one long-lived Python audio worker (scripts/local_audio.py) that
 * hosts faster-whisper and Piper. Requests are newline JSON with an id the
 * worker echoes back; streamed TTS chunks reach the caller through onChunk.
 * The worker is spawned once per server process, warmed up on start and
 * respawned with backoff if it dies, so a voice session never pays model load.
 */
export function createAudioWorker({
  pythonPath = resolvePython(),
  scriptPath = join(process.cwd(), 'scripts/local_audio.py'),
  env = process.env,
  spawnImpl = spawn,
  log = () => {},
  maxBackoffMs = 30_000,
} = {}) {
  let child = null;
  let buffer = '';
  let ready = null;
  let health = { whisper: false, piper: false, tts: 'none', starting: true };
  let backoffMs = 1000;
  let disposed = false;
  let respawnTimer = null;
  const pending = new Map();
  const stderrTail = [];

  function noteStderr(line) {
    if (!line) return;
    stderrTail.push(line);
    if (stderrTail.length > 20) stderrTail.shift();
    log('worker.stderr', { line });
  }

  function failAll(error) {
    for (const [id, job] of pending) {
      pending.delete(id);
      clearTimeout(job.timer);
      job.reject(error);
    }
  }

  function onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      noteStderr(line);
      return;
    }
    if (message.type === 'ready') {
      health = { ...message, starting: false };
      backoffMs = 1000;
      log('worker.ready', {
        whisper: message.whisper,
        device: message.device,
        piper: message.piper,
        warmupMs: message.warmupMs,
      });
      ready?.resolve(health);
      return;
    }
    const job = pending.get(message.id);
    if (!job) return;
    if (message.type === 'audio_chunk') {
      job.onChunk?.(message);
      return;
    }
    pending.delete(message.id);
    clearTimeout(job.timer);
    if (message.type === 'error') {
      const error = new Error(message.error || 'audio worker error');
      error.trace = message.trace;
      job.reject(error);
    } else job.resolve(message);
  }

  function spawnWorker() {
    if (disposed) return;
    buffer = '';
    let proc;
    try {
      proc = spawnImpl(pythonPath, [scriptPath], {
        env: {
          ...workerEnvironment(env),
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      onExit(null, null, error);
      return;
    }
    child = proc;
    log('worker.spawn', { pythonPath, pid: proc.pid });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) if (line.trim()) onLine(line.trim());
    });
    let errBuffer = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      errBuffer += chunk;
      const lines = errBuffer.split('\n');
      errBuffer = lines.pop() || '';
      for (const line of lines) noteStderr(line.trim());
    });
    proc.on('error', (error) => onExit(null, null, error));
    proc.on('exit', (code, signal) => {
      if (child === proc) onExit(code, signal);
    });
  }

  function onExit(code, signal, error) {
    const reason =
      error?.message ||
      `audio worker exited (code ${code}, signal ${signal})` +
        (stderrTail.length ? `: ${stderrTail.at(-1)}` : '');
    log('worker.exit', { code, signal, error: error?.message });
    child = null;
    health = { whisper: false, piper: false, tts: 'none', starting: !disposed };
    failAll(new Error(reason));
    const pendingReady = ready;
    ready = null;
    pendingReady?.reject(new Error(reason));
    if (disposed) return;
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      ensureStarted().catch(() => {});
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
  }

  function ensureStarted() {
    if (ready) return ready.promise;
    if (disposed) return Promise.reject(new Error('audio worker disposed'));
    ready = deferred();
    ready.promise.catch(() => {});
    spawnWorker();
    return ready.promise;
  }

  function write(payload) {
    if (!child?.stdin?.writable) throw new Error('audio worker is not running');
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function request(payload, { onChunk, timeoutMs = 60_000 } = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`audio worker timed out on ${payload.op}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, onChunk, timer });
      try {
        write({ ...payload, id });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  return {
    ensureStarted,
    health: () => health,
    lastStderr: () => stderrTail.slice(),
    get running() {
      return Boolean(child);
    },
    async transcribe(wavBytes, { language, prompt, timeoutMs } = {}) {
      await ensureStarted();
      return request(
        {
          op: 'transcribe',
          wav: Buffer.from(wavBytes).toString('base64'),
          language,
          prompt,
        },
        { timeoutMs: timeoutMs || 60_000 },
      );
    },
    async synthesize(text, { onChunk, timeoutMs, language } = {}) {
      await ensureStarted();
      return request(
        { op: 'tts', text, language },
        { onChunk, timeoutMs: timeoutMs || 60_000 },
      );
    },
    /** Speaker voice print for a 16 kHz WAV: { embedding: number[512], ... }. */
    async embed(wavBytes, { timeoutMs } = {}) {
      await ensureStarted();
      return request(
        { op: 'embed', wav: Buffer.from(wavBytes).toString('base64') },
        { timeoutMs: timeoutMs || 15_000 },
      );
    },
    async ping() {
      await ensureStarted();
      return request({ op: 'ping' }, { timeoutMs: 5000 });
    },
    /** Raw protocol access for diagnostics and tests. */
    async request(payload, options) {
      await ensureStarted();
      return request(payload, options);
    },
    dispose() {
      disposed = true;
      if (respawnTimer) clearTimeout(respawnTimer);
      const proc = child;
      child = null;
      ready = null;
      health = { whisper: false, piper: false, tts: 'none', starting: false };
      failAll(new Error('audio worker disposed'));
      try {
        proc?.kill();
      } catch {
        /* no-op */
      }
    },
  };
}

/** One worker per server process; Vite may call configureServer twice. */
export function sharedAudioWorker(options) {
  const key = '__gevAudioWorker';
  if (!globalThis[key]) {
    const worker = createAudioWorker(options);
    globalThis[key] = worker;
    // A force-killed dev server must not leave a Whisper process behind.
    const shutdown = () => worker.dispose();
    process.once('exit', shutdown);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
      try {
        process.once(signal, () => {
          shutdown();
          process.exit(0);
        });
      } catch {
        /* Signal unsupported on this platform. */
      }
    }
  }
  return globalThis[key];
}

export function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  return join(
    process.cwd(),
    process.platform === 'win32'
      ? '.venv-local/Scripts/python.exe'
      : '.venv-local/bin/python',
  );
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
