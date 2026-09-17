/**
 * In-memory sessions store: Map<externalUserId, SessionRecord>.
 *
 * STATELESSNESS NOTE — read this before relying on cross-request reuse:
 * each Vercel serverless function instance (and each api/ondemand/*.js cold
 * start) gets its OWN copy of this Map. There is no cross-instance sharing:
 * a request handled by instance A cannot see a session created on instance
 * B, and a cold start always begins empty. This is a deliberate, documented
 * limitation of the in-memory adapter — see docs/ONDEMAND_PROXY_DESIGN.md
 * "Statelessness" for the durable-store follow-up (Vercel KV / Upstash Redis
 * selected by an env var, e.g. ONDEMAND_SESSION_STORE=kv) and the pluggable
 * `SessionStore` interface below, which only the in-memory adapter
 * implements today.
 *
 * Memoised on `globalThis` so that repeated warm invocations of the SAME
 * instance — and multiple modules importing this file within one instance —
 * reuse a single Map instead of re-creating it per import.
 */

const GLOBAL_KEY = '__ondemandSessionsStoreV1__';
const DEFAULT_MAX_ENTRIES = 500;

/**
 * @typedef {{ sessionId: string, createdAt: string, lastUsedAt: string }} SessionRecord
 */

/**
 * Pluggable store interface. Only `createStore()` (in-memory) is implemented
 * in this file; a durable adapter can implement the same shape and be
 * swapped in behind `getStore()` without touching any caller.
 * @typedef {{
 *   get: (userId: string) => SessionRecord | undefined,
 *   set: (userId: string, rec: SessionRecord) => void,
 *   delete: (userId: string) => boolean,
 *   size: () => number,
 * }} SessionStore
 */

/**
 * Create a standalone in-memory LRU store. Exported directly (in addition to
 * the memoised `getStore()`) so tests can exercise eviction with a small
 * `maxEntries` instead of the production default of 500.
 * @param {number} [maxEntries]
 * @returns {SessionStore}
 */
export function createStore(maxEntries = DEFAULT_MAX_ENTRIES) {
  /** @type {Map<string, SessionRecord>} */
  const map = new Map();

  function touch(userId, rec) {
    // Map preserves insertion order; delete+re-set moves `userId` to the
    // "most recently used" end — the standard JS LRU-via-Map idiom.
    map.delete(userId);
    map.set(userId, rec);
  }

  return {
    get(userId) {
      const rec = map.get(userId);
      if (!rec) return undefined;
      touch(userId, rec);
      return rec;
    },
    set(userId, rec) {
      if (map.size >= maxEntries && !map.has(userId)) {
        // Evict the least-recently-used entry: with insertion-order
        // iteration, the first key is the oldest touched.
        const oldestKey = map.keys().next().value;
        if (oldestKey !== undefined) map.delete(oldestKey);
      }
      touch(userId, rec);
    },
    delete(userId) {
      return map.delete(userId);
    },
    size() {
      return map.size;
    },
  };
}

/** @returns {SessionStore} the store memoised on globalThis for this function instance. */
export function getStore() {
  if (!globalThis[GLOBAL_KEY]) {
    globalThis[GLOBAL_KEY] = createStore();
  }
  return globalThis[GLOBAL_KEY];
}

/** TEST-ONLY: drop the memoised store so the next getStore() starts fresh. */
export function __resetStoreForTests() {
  delete globalThis[GLOBAL_KEY];
}
