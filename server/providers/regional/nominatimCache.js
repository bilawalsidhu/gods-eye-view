import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { foldPlaceName } from '../../../src/data/placeNames.js';

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
 * Comparable form of a place name for matching results to the ask: the
 * shared fold (see `foldPlaceName`), bounded in length.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizePlaceName(value) {
  return foldPlaceName(value).slice(0, 200);
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

  const digestFor = (key) =>
    crypto.createHash('sha256').update(key).digest('hex');

  const fileFor = (key) =>
    path.join(dir, `${digestFor(key).slice(0, 40)}.json`);

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
      if (entry?.keyDigest !== digestFor(key) || !(entry.expiresAt > now()))
        return null;
      remember(key, entry);
      return entry;
    } catch {
      return null;
    }
  }

  async function set(key, payload, ttlMs) {
    const entry = {
      keyDigest: digestFor(key),
      payload,
      storedAt: now(),
      expiresAt: now() + ttlMs,
    };
    remember(key, entry);
    if (!dir) return;
    const body = JSON.stringify(entry);
    if (Buffer.byteLength(body) > maxEntryBytes) return;
    let temp = null;
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.chmod(dir, 0o700);
      const file = fileFor(key);
      temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      await fs.writeFile(temp, body, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, file);
      temp = null;
    } catch {
      return;
    } finally {
      if (temp) await fs.rm(temp, { force: true }).catch(() => {});
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

  return { get, set, sweep };
}
