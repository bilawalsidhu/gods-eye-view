import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hardenCredentialFile } from '../src/keySetupHardening.mjs';

export const DEBUG_REQUEST_MAX_BYTES = 64 * 1024;
export const DEBUG_FILE_MAX_BYTES = 8 * 1024 * 1024;

export function redactDebugRecord(value, depth = 0) {
  if (depth > 8) return '[MaxDepth]';
  if (typeof value === 'string') {
    return value.replace(/data:image\/[^\s"']+/gi, '[Redacted image]')
      .replace(/(?:sk-(?:proj-)?|ek_)[A-Za-z0-9_-]{16,}/g, '[Redacted key]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [Redacted]')
      .replace(/AIza[0-9A-Za-z_-]{30,}/g, '[Redacted Google key]')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[Redacted JWT]')
      .slice(0, 4096);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactDebugRecord(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
      key,
      /key|token|secret|password|authorization|bearer/i.test(key)
        ? '[Redacted]' : redactDebugRecord(item, depth + 1),
    ]));
  }
  return value;
}

/** One bounded file per process; serialize appends and reject queue overflow. */
export function createDebugLogWriter({ tempRoot = os.tmpdir(), maxBytes = DEBUG_FILE_MAX_BYTES,
  harden = hardenCredentialFile, onCreated = () => {} } = {}) {
  let file;
  let used = 0;
  let pending = 0;
  let queue = Promise.resolve();
  let failed = false;
  return async (record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid log record');
    if (pending >= 8 || failed) throw new Error('Debug logging unavailable');
    const data = Buffer.from(`${JSON.stringify({ ...redactDebugRecord(record), loggedAt: new Date().toISOString() })}\n`);
    pending += 1;
    const operation = queue.then(async () => {
      if (failed) throw new Error('Debug logging unavailable');
      if (used + data.length > maxBytes) throw new Error('Debug log is full');
      if (!file) {
        const directory = await fs.mkdtemp(path.join(tempRoot, 'gev-debug-'));
        const candidate = path.join(directory, 'realtime-conversations.jsonl');
        const handle = await fs.open(candidate, 'wx', 0o600);
        await handle.close();
        // Restrict the empty file before the first record, including on Windows.
        if (!harden(candidate)) { failed = true; throw new Error('Cannot restrict debug log permissions'); }
        file = candidate;
        onCreated(file);
      }
      // Reserve before writing: a partial I/O failure must not undercount bytes.
      used += data.length;
      try { await fs.appendFile(file, data, { flag: 'a' }); }
      catch (error) { failed = true; throw error; }
    });
    queue = operation.catch(() => {});
    try { await operation; } finally { pending -= 1; }
  };
}
