// ORYN prototype persistence: one browser-local store per record collection.
//
// This is a LOCAL DEMO store. Records live in this browser's localStorage
// under the `oryn:` prefix and never leave the machine. There is no backend,
// no organization isolation and no sharing. Credentials and secrets must never
// be written here; the session module stores only display fields.
import { t } from '../../i18n/index.js';

export const STORE_PREFIX = 'oryn:';
export const STORE_VERSION = 1;
const MAX_RECORDS = 500;
const MAX_TEXT = 20_000;

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

/** The storage this page can use; falls back to memory when storage throws. */
export function resolveStorage(candidate = globalThis.localStorage) {
  try {
    if (!candidate) return memoryStorage();
    const probe = `${STORE_PREFIX}probe`;
    candidate.setItem(probe, '1');
    candidate.removeItem(probe);
    return candidate;
  } catch {
    return memoryStorage();
  }
}

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isIsoTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function isValidLongitude(value) {
  return isFiniteNumber(value) && value >= -180 && value <= 180;
}

export function isValidLatitude(value) {
  return isFiniteNumber(value) && value >= -90 && value <= 90;
}

/** Bounded plain text; rejects anything that is not a short string. */
export function cleanText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\0/g, '').trim();
  if (text.length > max) return text.slice(0, max);
  return text;
}

export function newId(prefix = 'rec') {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${random}`;
}

/**
 * A validated collection of records persisted as one JSON document.
 * @param {string} name Collection name, e.g. `scenes`.
 * @param {(record:any) => (object|null)} validate Returns the clean record or null.
 */
export function createCollection(name, validate, { storage } = {}) {
  if (!name || typeof validate !== 'function')
    throw new TypeError('A collection name and validator are required');
  const store = resolveStorage(storage);
  const key = `${STORE_PREFIX}${name}:v${STORE_VERSION}`;
  const listeners = new Set();
  let cache = null;
  let dropped = 0;

  function read() {
    if (cache) return cache;
    let parsed = null;
    try {
      const raw = store.getItem(key);
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const clean = [];
    for (const item of items) {
      const record = validate(item);
      if (record) clean.push(record);
      else dropped += 1;
    }
    cache = clean.slice(0, MAX_RECORDS);
    return cache;
  }

  function write(items) {
    cache = items.slice(0, MAX_RECORDS);
    try {
      store.setItem(
        key,
        JSON.stringify({ version: STORE_VERSION, items: cache }),
      );
    } catch (error) {
      console.warn(`[ORYN] ${name}: could not persist`, error);
    }
    for (const listener of [...listeners]) {
      try {
        listener(cache);
      } catch (error) {
        console.warn(`[ORYN] ${name}: listener failed`, error);
      }
    }
  }

  return Object.freeze({
    name,
    key,
    /** Records rejected while reading, for an honest UI count. */
    get droppedCount() {
      read();
      return dropped;
    },
    list: () => [...read()],
    get: (id) => read().find((item) => item.id === id) ?? null,
    /** Validate and insert or replace a record. Returns the clean record. */
    put(record) {
      const clean = validate(record);
      if (!clean) throw new TypeError(t('Record failed validation'));
      const items = read().filter((item) => item.id !== clean.id);
      write([clean, ...items]);
      return clean;
    },
    remove(id) {
      const items = read();
      const next = items.filter((item) => item.id !== id);
      if (next.length === items.length) return false;
      write(next);
      return true;
    },
    clear: () => write([]),
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
