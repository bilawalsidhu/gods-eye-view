import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 86_400_000;

/** Entry files this cache writes: a 40-hex-digit key hash. */
const CACHE_FILE_RE = /^[0-9a-f]{40}\.json$/;

/** How long an answer is kept, by what it was. */
export const NOMINATIM_CACHE_TTL_MS = Object.freeze({
  outline: 90 * DAY_MS,
  place: 30 * DAY_MS,
  notFound: DAY_MS,
});

/**
 * Comparable form of a place name: Unicode-normalized (NFKC), accents
 * removed, case folded, punctuation and symbols collapsed to single spaces,
 * and a leading article dropped. Non-Latin scripts are kept as they are:
 * "東京" stays "東京", while "São Paulo", "sao paulo" and "SÃO PAULO!" meet.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizePlaceName(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, ' ')
    .trim()
    .replace(/^(?:the) /, '')
    .slice(0, 200);
}

/**
 * Memory + disk cache for Nominatim answers.
 *
 * Every entry carries its own expiry. Memory is an LRU bounded by entries;
 * disk is bounded by entries and bytes, with expired files removed during a
 * periodic sweep. A null `dir` keeps everything in memory.
 */
export function createNominatimCache({
  dir = null,
  maxMemoryEntries = 256,
  maxDiskEntries = 4000,
  maxDiskBytes = 64 * 1024 * 1024,
  maxEntryBytes = 2 * 1024 * 1024,
  sweepEvery = 50,
  now = Date.now,
} = {}) {
  const memory = new Map();
  let writesSinceSweep = 0;
  let sweeping = null;

  const fileFor = (key) =>
    path.join(
      dir,
      `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 40)}.json`,
    );

  function remember(key, entry) {
    memory.delete(key);
    memory.set(key, entry);
    while (memory.size > maxMemoryEntries)
      memory.delete(memory.keys().next().value);
  }

  async function get(key) {
    const hit = memory.get(key);
    if (hit) {
      if (hit.expiresAt > now()) {
        remember(key, hit);
        return hit;
      }
      memory.delete(key);
    }
    if (!dir) return null;
    try {
      const entry = JSON.parse(await fs.readFile(fileFor(key), 'utf8'));
      if (entry?.key !== key || !(entry.expiresAt > now())) return null;
      remember(key, entry);
      return entry;
    } catch {
      return null;
    }
  }

  async function set(key, payload, ttlMs) {
    const entry = { key, payload, storedAt: now(), expiresAt: now() + ttlMs };
    remember(key, entry);
    if (!dir) return;
    const body = JSON.stringify(entry);
    if (Buffer.byteLength(body) > maxEntryBytes) return;
    try {
      await fs.mkdir(dir, { recursive: true });
      const file = fileFor(key);
      const temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, body);
      await fs.rename(temp, file);
    } catch {
      return;
    }
    writesSinceSweep += 1;
    if (writesSinceSweep >= sweepEvery) {
      writesSinceSweep = 0;
      await sweep();
    }
  }

  /** Remove expired files, then the oldest until both disk bounds hold. */
  async function sweep() {
    if (!dir) return;
    if (sweeping) return sweeping;
    sweeping = (async () => {
      let names;
      try {
        names = await fs.readdir(dir);
      } catch {
        return;
      }
      const files = [];
      for (const name of names) {
        // Only this cache's own entry files; anything else in the directory
        // is left alone.
        if (!CACHE_FILE_RE.test(name)) continue;
        const file = path.join(dir, name);
        let stat;
        let text;
        try {
          [stat, text] = await Promise.all([
            fs.stat(file),
            fs.readFile(file, 'utf8'),
          ]);
        } catch {
          // Unreadable right now (gone, busy, too many open files): an error
          // reading is not evidence the entry is bad, so it stays.
          continue;
        }
        let expiresAt;
        try {
          expiresAt = JSON.parse(text)?.expiresAt;
        } catch {
          expiresAt = null; // corrupt: removed below
        }
        if (!(expiresAt > now())) {
          await fs.rm(file, { force: true }).catch(() => {});
          continue;
        }
        files.push({ file, size: stat.size, at: stat.mtimeMs });
      }
      files.sort((a, b) => a.at - b.at);
      let bytes = files.reduce((sum, entry) => sum + entry.size, 0);
      while (
        files.length &&
        (files.length > maxDiskEntries || bytes > maxDiskBytes)
      ) {
        const oldest = files.shift();
        bytes -= oldest.size;
        await fs.rm(oldest.file, { force: true }).catch(() => {});
      }
    })().finally(() => {
      sweeping = null;
    });
    return sweeping;
  }

  return { get, set, sweep, memorySize: () => memory.size };
}
