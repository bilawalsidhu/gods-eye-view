// src/data/localCache.js
/**
 * localStorage-backed response cache — the client-side tier of the app's
 * caching strategy ("aggressive caching to local storage", operator request
 * 2026-08-29). The dev-server proxies cache upstream answers on disk; a
 * static deployment has no such disk, so the BROWSER carries the cache
 * instead: data that is effectively immutable (aircraft type/route lookups,
 * TLE groups, station directories) survives across sessions without
 * re-hitting the free community APIs those layers ride on.
 *
 * Design constraints, in priority order:
 *   1. NEVER break the caller. Every storage failure (quota, privacy mode,
 *      disabled storage, corrupted JSON) degrades to a cache miss.
 *   2. Bounded memory. Entries are capped per namespace and evicted
 *      least-recently-read; a quota error triggers one eviction-and-retry.
 *   3. Honest TTLs. An expired entry is a miss and is removed, not served.
 *
 * Pure module: injects its storage, so tests run against a Map-based stub
 * and the module stays silent where localStorage is unavailable.
 *
 * @module data/localCache
 */

const NAMESPACE = 'gev:cache:';
/** Entry cap. ~200 immutable lookups is far above any session's working set. */
const MAX_ENTRIES = 500;
/** Fraction of entries evicted when the quota is hit before one retry. */
const EVICT_FRACTION = 0.2;

/** @type {Storage|null|undefined} undefined = not resolved yet. */
let _storage;
/** Set of keys touched since the last eviction sweep, for LRU ordering. */
const _lastRead = new Map();

/**
 * Resolve the backing store once. `undefined` stands for "not looked at yet";
 * `null` means "unavailable — cache disabled".
 *
 * @returns {Storage|null} the probe-verified store, or null when access throws
 */
function resolveStorage() {
  if (_storage !== undefined) return _storage;
  try {
    const store = globalThis.localStorage;
    if (!store) {
      _storage = null;
      return _storage;
    }
    // localStorage can exist yet throw on ACCESS (Safari private mode): a
    // probe write/read decides availability by behavior, not by presence.
    const probe = `${NAMESPACE}__probe__`;
    store.setItem(probe, '1');
    store.removeItem(probe);
    _storage = store;
  } catch {
    _storage = null;
  }
  return _storage;
}

/**
 * Override the backing store (tests, or an explicit `null` to disable).
 *
 * @param {Storage|null} storage the store to use from now on, or null to
 *   disable the cache entirely (every read misses, every write is dropped)
 */
export function setLocalCacheStorage(storage) {
  _storage = storage;
  _lastRead.clear();
}

/** Fully clear the app's namespace (diagnostics; never called at runtime). */
export function clearLocalCache() {
  const store = resolveStorage();
  if (!store) return;
  const doomed = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key && key.startsWith(NAMESPACE)) doomed.push(key);
  }
  for (const key of doomed) {
    try {
      store.removeItem(key);
    } catch {
      /* best effort */
    }
  }
  _lastRead.clear();
}

/**
 * Read a cached value.
 *
 * @param {string} key Cache key (namespaced automatically).
 * @param {{ nowMs?: number }} [opts] clock override for TTL expiry checks.
 * @returns {{ hit: boolean, value: (object|Array|null) }} `value` is null on a
 *   miss; a cached JSON `null` is not a representable value by design.
 */
export function readLocalCache(key, { nowMs = Date.now() } = {}) {
  const store = resolveStorage();
  const namespaced = NAMESPACE + key;
  if (!store) return { hit: false, value: null };
  let raw;
  try {
    raw = store.getItem(namespaced);
  } catch {
    return { hit: false, value: null };
  }
  if (!raw) return { hit: false, value: null };
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    // A corrupted entry is worse than no entry: drop it and report a miss.
    try {
      store.removeItem(namespaced);
    } catch {
      /* best effort */
    }
    return { hit: false, value: null };
  }
  if (!entry || typeof entry !== 'object' || !entry.c) {
    return { hit: false, value: null };
  }
  const expiresAt = (entry.w || 0) + (entry.t || 0);
  if (nowMs >= expiresAt) {
    try {
      store.removeItem(namespaced);
    } catch {
      /* best effort */
    }
    _lastRead.delete(namespaced);
    return { hit: false, value: null };
  }
  _lastRead.set(namespaced, nowMs);
  return { hit: true, value: entry.c };
}

/**
 * Write a cached value. Fails soft: quota errors trigger one LRU eviction
 * sweep and a single retry, then the write is dropped.
 *
 * @param {string} key Cache key (namespaced automatically).
 * @param {object|Array} value JSON-serializable payload (not null).
 * @param {{ ttlMs: number, nowMs?: number }} opts Positive TTL is required —
 *   an entry without an expiry would be an unbounded commitment.
 * @returns {boolean} True when the value was persisted.
 */
export function writeLocalCache(key, value, { ttlMs, nowMs = Date.now() } = {}) {
  const store = resolveStorage();
  if (!store || !Number.isFinite(ttlMs) || ttlMs <= 0 || value === null || value === undefined) {
    return false;
  }
  const namespaced = NAMESPACE + key;
  const entry = { c: value, w: nowMs, t: ttlMs };
  try {
    store.setItem(namespaced, JSON.stringify(entry));
    _lastRead.set(namespaced, nowMs);
    return true;
  } catch {
    // Quota (or an uncooperative store): evict the coldest slice and retry once.
    evictColdest(store, { keep: namespaced, nowMs });
    try {
      store.setItem(namespaced, JSON.stringify(entry));
      _lastRead.set(namespaced, nowMs);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Evict the least-recently-read entries to make room for `keep`.
 * Read tracking lives in memory; entries never read this session rank coldest.
 *
 * @param {Storage} store the resolved backing store to delete from.
 * @param {{ keep: string, nowMs: number }} opts `keep` is the namespaced key
 *   being written (never evicted); `nowMs` is the current clock for consistency.
 */
function evictColdest(store, { keep, nowMs }) {
  const entries = [];
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (!key || !key.startsWith(NAMESPACE) || key === keep) continue;
      entries.push([key, _lastRead.get(key) || 0]);
    }
  } catch {
    return;
  }
  if (!entries.length) return;
  entries.sort((a, b) => a[1] - b[1]);
  const count = Math.max(1, Math.ceil(entries.length * EVICT_FRACTION));
  for (const [key] of entries.slice(0, count)) {
    try {
      store.removeItem(key);
    } catch {
      /* best effort */
    }
    _lastRead.delete(key);
  }
  void nowMs;
}

/**
 * Enforce the entry cap by dropping the coldest entries. Called opportunistically
 * after writes; a small overshoot is harmless, an unbounded store is not.
 *
 * @param {number} maxEntries steady-state cap; defaults to the module constant.
 */
export function trimLocalCache(maxEntries = MAX_ENTRIES) {
  const store = resolveStorage();
  if (!store) return;
  const keys = [];
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(NAMESPACE)) keys.push(key);
    }
  } catch {
    return;
  }
  if (keys.length <= maxEntries) return;
  keys.sort((a, b) => (_lastRead.get(a) || 0) - (_lastRead.get(b) || 0));
  for (const key of keys.slice(0, keys.length - maxEntries)) {
    try {
      store.removeItem(key);
    } catch {
      /* best effort */
    }
    _lastRead.delete(key);
  }
}
