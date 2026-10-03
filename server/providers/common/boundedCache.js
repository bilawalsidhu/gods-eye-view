import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';

/**
 * A bounded two-level cache for JSON answers: memory (entry count) and disk
 * (entry count, total bytes, age). Every memory insertion goes through one
 * function, so a disk hit is bounded like a fresh answer; disk writes are
 * followed by a prune that removes expired files first, then the oldest,
 * until both quotas hold.
 *
 * @param {object} options
 * @param {string|null} options.dir Disk directory; null keeps memory only.
 * @param {number} options.ttlMs Age past which an entry is not served.
 * @param {number} [options.maxMemoryEntries]
 * @param {number} [options.maxDiskEntries]
 * @param {number} [options.maxDiskBytes]
 * @param {() => number} [options.now]
 */
export function createBoundedCache({
  dir,
  ttlMs,
  maxMemoryEntries = 60,
  maxDiskEntries = 400,
  maxDiskBytes = 256 * 1024 * 1024,
  now = () => Date.now(),
}) {
  const memory = new Map();
  let pruning = null;
  let prunePending = false;

  const fileFor = (key) =>
    path.join(dir, `${createHash('sha1').update(key).digest('hex')}.json`);

  function remember(key, entry) {
    memory.delete(key);
    memory.set(key, entry);
    while (memory.size > maxMemoryEntries)
      memory.delete(memory.keys().next().value);
  }

  async function prune() {
    if (!dir) return;
    let names;
    try {
      names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.json'));
    } catch {
      return;
    }
    const files = [];
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const stat = await fsp.stat(file);
        files.push({ file, size: stat.size, mtime: stat.mtimeMs });
      } catch {
        /* removed meanwhile */
      }
    }
    const cutoff = now() - ttlMs;
    const keep = [];
    for (const entry of files) {
      if (entry.mtime < cutoff) await fsp.rm(entry.file, { force: true });
      else keep.push(entry);
    }
    keep.sort((a, b) => a.mtime - b.mtime);
    let bytes = keep.reduce((sum, entry) => sum + entry.size, 0);
    while (
      keep.length &&
      (keep.length > maxDiskEntries || bytes > maxDiskBytes)
    ) {
      const oldest = keep.shift();
      bytes -= oldest.size;
      await fsp.rm(oldest.file, { force: true });
    }
  }

  /** Run one prune at a time; a request during a prune schedules one more. */
  function schedulePrune() {
    if (pruning) {
      prunePending = true;
      return pruning;
    }
    pruning = prune()
      .catch(() => {})
      .finally(() => {
        pruning = null;
        if (prunePending) {
          prunePending = false;
          schedulePrune();
        }
      });
    return pruning;
  }

  return {
    /** The cached value, or undefined. A disk hit is re-inserted into memory. */
    async get(key) {
      const held = memory.get(key);
      if (held && now() - held.cachedAt <= ttlMs) return held.value;
      if (held) memory.delete(key);
      if (!dir) return undefined;
      try {
        const entry = JSON.parse(await fsp.readFile(fileFor(key), 'utf8'));
        if (!Number.isFinite(entry?.cachedAt) || now() - entry.cachedAt > ttlMs)
          return undefined;
        remember(key, entry);
        return entry.value;
      } catch {
        return undefined;
      }
    },
    /** Store a value in memory and, when a directory is set, on disk. */
    async set(key, value) {
      const entry = { value, cachedAt: now() };
      remember(key, entry);
      if (!dir) return;
      try {
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(fileFor(key), JSON.stringify(entry));
      } catch {
        return;
      }
      await schedulePrune();
    },
    prune: schedulePrune,
    get memorySize() {
      return memory.size;
    },
  };
}
