import {
  isOverBudget,
  normalizeBudget,
  utcDayKey,
} from '../data/tomtomTiles.js';

/**
 * On-device governors plus the shared keyed-transport guard.
 *
 * Two budget keepers live here, both over an injected Preferences-shaped
 * store (`{ get, set, remove }`, values persisted as JSON strings) and an
 * injected clock (a `() => epochMs` function or a `{ now }` object), so
 * tests drive them with a fake clock and the device wires real Preferences:
 *
 * - `createCreditGovernor` — OpenSky's ~4000/day credit budget. The server
 *   proxy stretches its cache TTL as credits thin (9s → 30s → 90s → 300s);
 *   on-device the client polls no faster than every 30s, so the governor
 *   reports the adaptive 30/90/300s poll interval from the last-reported
 *   `X-Rate-Limit-Remaining` value, plus a 429-cooldown override.
 * - `createDailyBudget` — TomTom's 6000/day tile budget (200k/month free
 *   tier / 31 days, rounded down; mirrors the server proxy). Persisted per
 *   UTC day with rollover, so a reinstall-day restart cannot double-spend.
 *
 * `assertKeyedHttps` is the one keyed-traffic rule every Task 4 adapter
 * shares: provider keys travel only over `https:` (fetch) or `wss:`
 * (sockets). Plain `http:`/`ws:` with a key attached is refused before any
 * transport call, with a message naming only the host — never the query,
 * which may carry the key.
 *
 * @module mobile/governors
 */

/** Rejection code for keyed traffic aimed at a non-TLS URL. */
export const KEYED_HTTP_REFUSED = 'KEYED_HTTP_REFUSED';

/**
 * Refuse a keyed URL unless it uses TLS. Accepts `https:` (fetch) and
 * `wss:` (sockets); everything else — including unparseable input — is
 * refused before any network traffic.
 * @param {string|URL} url Candidate keyed URL.
 * @returns {void} Throws when the URL may not carry a provider key.
 */
export function assertKeyedHttps(url) {
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(String(url));
  } catch {
    throw Object.assign(
      new Error('Refused keyed request to an unparseable URL'),
      {
        code: KEYED_HTTP_REFUSED,
      },
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'wss:') {
    throw Object.assign(
      new Error(
        `Refused keyed request over "${parsed.protocol}//${parsed.hostname}": provider keys require HTTPS`,
      ),
      { code: KEYED_HTTP_REFUSED },
    );
  }
}

/**
 * Normalize the injected clock to a `() => epochMs` function.
 * @param {Function|{ now: Function }|undefined} clock Injected clock.
 * @returns {Function} Millisecond clock, defaulting to `Date.now`.
 */
function normalizeClock(clock) {
  if (typeof clock === 'function') return clock;
  if (clock && typeof clock.now === 'function') return () => clock.now();
  return () => Date.now();
}

/**
 * Read a JSON document from a Preferences-shaped store. Corrupt or missing
 * state resolves to null (fail closed — the governor rebuilds it).
 * @param {{ get: Function }|null} storage Injected store.
 * @param {string} key Storage key.
 * @returns {Promise<object|null>} Parsed state, or null.
 */
async function loadJson(storage, key) {
  if (!storage || typeof storage.get !== 'function') return null;
  try {
    const result = await storage.get({ key });
    if (typeof result?.value !== 'string' || !result.value) return null;
    const parsed = JSON.parse(result.value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persist a JSON document to a Preferences-shaped store. A missing store
 * means memory-only operation; write failures are swallowed so metering
 * can never break a feed.
 * @param {{ set: Function }|null} storage Injected store.
 * @param {string} key Storage key.
 * @param {object} state State to persist.
 * @returns {Promise<void>}
 */
async function saveJson(storage, key, state) {
  if (!storage || typeof storage.set !== 'function') return;
  try {
    await storage.set({ key, value: JSON.stringify(state) });
  } catch {
    // Metering must never break the feed it meters.
  }
}

// ---------------------------------------------------------------------------
// OpenSky credit governor
// ---------------------------------------------------------------------------

/** Storage key for the persisted OpenSky credit state. */
export const CREDIT_GOVERNOR_STORAGE_KEY = 'gev:opensky-credit';

/** 429-cooldown bounds (mirrors the server proxy: 30s … 30min). */
export const CREDIT_COOLDOWN_MIN_MS = 30_000;
export const CREDIT_COOLDOWN_MAX_MS = 30 * 60_000;

/**
 * Map the remaining OpenSky daily credit budget to the on-device poll
 * interval. The device polls no faster than every 30s, so the server's
 * sub-30s tier collapses into it: >1200 → 30s, >400 → 90s, otherwise 300s.
 * Unknown budgets poll at the healthy rate rather than stalling the layer.
 * @param {number|null|undefined} remaining Last-reported `X-Rate-Limit-Remaining`.
 * @returns {number} Poll interval in milliseconds (30_000 | 90_000 | 300_000).
 */
export function openskyPollIntervalMs(remaining) {
  if (!Number.isFinite(remaining)) return 30_000;
  if (remaining > 1200) return 30_000;
  if (remaining > 400) return 90_000;
  return 300_000;
}

/**
 * Create the OpenSky credit governor.
 * @param {{ storage?: { get: Function, set: Function }|null, clock?: Function|{ now: Function }, key?: string }} options Injected store, clock, and storage key.
 * @returns {{ intervalFor: Function, reportRemaining: Function, reportRateLimited: Function, notePoll: Function, pollDelayMs: Function, snapshot: Function }} Governor handle.
 */
export function createCreditGovernor({
  storage = null,
  clock,
  key = CREDIT_GOVERNOR_STORAGE_KEY,
} = {}) {
  const now = normalizeClock(clock);
  let state = { remaining: null, lastPollAt: 0, cooldownUntil: 0 };

  async function load() {
    const persisted = await loadJson(storage, key);
    if (persisted) {
      state = {
        remaining: Number.isFinite(persisted.remaining)
          ? persisted.remaining
          : null,
        lastPollAt: Number.isFinite(persisted.lastPollAt)
          ? persisted.lastPollAt
          : 0,
        cooldownUntil: Number.isFinite(persisted.cooldownUntil)
          ? persisted.cooldownUntil
          : 0,
      };
    }
    return state;
  }

  async function persist() {
    await saveJson(storage, key, state);
  }

  return {
    /**
     * Pure tier mapping (no state): the poll interval for a credit balance.
     * @param {number|null|undefined} remaining Credit balance.
     * @returns {number} Poll interval in milliseconds.
     */
    intervalFor: (remaining) => openskyPollIntervalMs(remaining),
    /**
     * Record the latest `X-Rate-Limit-Remaining` value (persists it).
     * @param {number|null|undefined} remaining Reported balance.
     * @returns {Promise<void>}
     */
    async reportRemaining(remaining) {
      await load();
      state.remaining = Number.isFinite(remaining) ? remaining : null;
      await persist();
    },
    /**
     * Record a 429 with an optional server-supplied retry delay. The
     * cooldown is bounded 30s … 30min like the server proxy; 2min when the
     * header is absent.
     * @param {number} [retryAfterMs] Server-supplied delay.
     * @returns {Promise<void>}
     */
    async reportRateLimited(retryAfterMs = 120_000) {
      await load();
      const wait = Number.isFinite(retryAfterMs) ? retryAfterMs : 120_000;
      state.cooldownUntil =
        now() +
        Math.min(
          Math.max(wait, CREDIT_COOLDOWN_MIN_MS),
          CREDIT_COOLDOWN_MAX_MS,
        );
      await persist();
    },
    /**
     * Note that a poll just went out (starts the interval clock).
     * @returns {Promise<void>}
     */
    async notePoll() {
      await load();
      state.lastPollAt = now();
      await persist();
    },
    /**
     * Milliseconds until the next poll is due (0 when due now).
     * @returns {Promise<number>} Non-negative delay.
     */
    async pollDelayMs() {
      await load();
      const at = now();
      const due = Math.max(
        state.lastPollAt + openskyPollIntervalMs(state.remaining),
        state.cooldownUntil,
      );
      return Math.max(0, due - at);
    },
    /**
     * Inspect the persisted governor state (remaining, interval, cooldown).
     * @returns {Promise<{ remaining: number|null, intervalMs: number, lastPollAt: number, cooldownUntil: number }>} Snapshot.
     */
    async snapshot() {
      await load();
      return {
        remaining: state.remaining,
        intervalMs: openskyPollIntervalMs(state.remaining),
        lastPollAt: state.lastPollAt,
        cooldownUntil: state.cooldownUntil,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// TomTom daily budget
// ---------------------------------------------------------------------------

/**
 * Default daily tile budget: TomTom's 200,000/month free allowance over a
 * 31-day month (6,451), rounded down for headroom. Mirrors the server proxy.
 */
export const DAILY_BUDGET_DEFAULT_LIMIT = 6000;

/** Storage key for the persisted TomTom budget counter. */
export const DAILY_BUDGET_STORAGE_KEY = 'gev:tomtom-budget';

/**
 * Create a persisted UTC-day tile budget. The counter rolls to zero on day
 * change (via the shared `normalizeBudget` the server proxy uses), so a
 * midnight restart cannot double-spend yesterday's allowance.
 * @param {{ storage?: { get: Function, set: Function }|null, clock?: Function|{ now: Function }, limit?: number, key?: string }} options Injected store, clock, daily limit, and storage key.
 * @returns {{ trySpend: Function, count: Function, remaining: Function, state: Function }} Budget handle.
 */
export function createDailyBudget({
  storage = null,
  clock,
  limit = DAILY_BUDGET_DEFAULT_LIMIT,
  key = DAILY_BUDGET_STORAGE_KEY,
} = {}) {
  const now = normalizeClock(clock);
  const cap =
    Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : DAILY_BUDGET_DEFAULT_LIMIT;
  // Closure state seeded once from the store: memory-only operation (no
  // storage) still counts, and every call re-normalizes for day rollover.
  let memory = null;

  async function current() {
    if (!memory) {
      const persisted = await loadJson(storage, key);
      memory = normalizeBudget(persisted, utcDayKey(now()));
    } else {
      memory = normalizeBudget(memory, utcDayKey(now()));
    }
    return memory;
  }

  return {
    /**
     * Spend one tile from today's budget. Returns false (spending nothing)
     * once the cap is reached.
     * @returns {Promise<boolean>} True when the spend was counted.
     */
    async trySpend() {
      const state = await current();
      if (isOverBudget(state, cap)) return false;
      state.count += 1;
      await saveJson(storage, key, state);
      return true;
    },
    /**
     * Tiles spent today (0 after a day rollover).
     * @returns {Promise<number>} Today's count.
     */
    async count() {
      return (await current()).count;
    },
    /**
     * Tiles still available today (never negative).
     * @returns {Promise<number>} Remaining allowance.
     */
    async remaining() {
      return Math.max(0, cap - (await current()).count);
    },
    /**
     * Inspect the budget (`{ date, count, limit }` — no values, no keys).
     * @returns {Promise<{ date: string, count: number, limit: number }>} Snapshot.
     */
    async state() {
      const state = await current();
      return { date: state.date, count: state.count, limit: cap };
    },
  };
}
