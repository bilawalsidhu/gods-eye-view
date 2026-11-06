import {
  CCTV_DEFAULT_FOV_DEG,
  CCTV_DEFAULT_PITCH_DEG,
  cctvFallbackHeadingFromId,
} from '../../../src/sources/cctvPose.js';
/** Server-side admission policy for billed CCTV Street View requests. */
export const STREET_VIEW_WINDOW_MS = 60_000;
export const STREET_VIEW_DAY_MS = 86_400_000;
export const STREET_VIEW_PER_CLIENT_MAX_REQUESTS = 16;
export const STREET_VIEW_MAX_REQUESTS = 32;
export const STREET_VIEW_DAILY_MAX_REQUESTS = 512;
export const STREET_VIEW_MAX_PENDING = 8;
export const STREET_VIEW_MAX_TRACKED_KEYS = 256;
/** A refusal is not a failed Google fetch; clients should retain their last frame. */
export const STREET_VIEW_DEFERRED = Object.freeze({ deferred: true });

/**
 * Accept only a registered source with valid geographic coordinates.
 * Query-string overrides are deliberately ignored: they are untrusted input.
 */
export function registeredStreetViewLocation(source) {
  if (!source || typeof source.id !== 'string' || !source.id.trim())
    return null;
  if (
    source.lat == null ||
    source.lon == null ||
    (typeof source.lat === 'string' && !source.lat.trim()) ||
    (typeof source.lon === 'string' && !source.lon.trim())
  )
    return null;
  const lat = Number(source.lat);
  const lon = Number(source.lon);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  )
    return null;
  const optionalNumber = (value) =>
    value == null ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && !value.trim())
      ? NaN
      : Number(value);
  const heading = optionalNumber(source.headingDeg);
  const fov = optionalNumber(source.fovDeg);
  const pitch = optionalNumber(source.pitchDeg);
  return {
    lat,
    lon,
    heading: Number.isFinite(heading)
      ? ((heading % 360) + 360) % 360
      : cctvFallbackHeadingFromId(source.id),
    fov: Number.isFinite(fov)
      ? Math.max(20, Math.min(120, fov))
      : CCTV_DEFAULT_FOV_DEG,
    pitch: Number.isFinite(pitch)
      ? Math.max(-55, Math.min(-2, pitch))
      : CCTV_DEFAULT_PITCH_DEG,
  };
}

/**
 * Parse operator-selected ceilings. An explicit zero disables paid fallback;
 * malformed input keeps the protective default, never means unlimited.
 */
export function streetViewCapFromEnv(value, defaultLimit) {
  if (value == null || String(value).trim() === '') return defaultLimit;
  const raw = String(value).trim();
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return defaultLimit;
  const cap = Number(raw);
  return Number.isSafeInteger(cap) && cap <= 100_000 ? cap : defaultLimit;
}

/**
 * Per-client and process-wide request admission, coupled to a rolling 24-hour
 * attempt budget. Coalesce concurrent requests, without caching image bytes.
 * All maps have finite bounds; requests are charged before fetch, including
 * upstream errors. This is process-local protection, not a billing guarantee.
 */
export function createStreetViewAdmission({
  now = Date.now,
  windowMs = STREET_VIEW_WINDOW_MS,
  dailyWindowMs = STREET_VIEW_DAY_MS,
  perClientMax = STREET_VIEW_PER_CLIENT_MAX_REQUESTS,
  globalMax = STREET_VIEW_MAX_REQUESTS,
  dailyMax = STREET_VIEW_DAILY_MAX_REQUESTS,
  successCooldownMs = 0,
  failureCooldownMs = 120_000,
  maxPending = STREET_VIEW_MAX_PENDING,
  maxTracked = STREET_VIEW_MAX_TRACKED_KEYS,
} = {}) {
  const nonNegativeInteger = (n) => Number.isSafeInteger(n) && n >= 0;
  if (
    typeof now !== 'function' ||
    !Number.isFinite(windowMs) ||
    windowMs <= 0 ||
    !Number.isFinite(dailyWindowMs) ||
    dailyWindowMs <= 0 ||
    ![perClientMax, globalMax, dailyMax].every(nonNegativeInteger) ||
    ![successCooldownMs, failureCooldownMs].every(
      (n) => Number.isFinite(n) && n >= 0,
    ) ||
    ![maxPending, maxTracked].every((n) => Number.isSafeInteger(n) && n > 0)
  )
    throw new TypeError('Invalid Street View admission policy');

  const clients = new Map();
  const pending = new Map();
  const cooldowns = new Map();
  const stats = {
    attempts: 0,
    denied: 0,
    coalesced: 0,
    cooldown: 0,
    failures: 0,
  };
  let minuteStart = now();
  let minuteUsed = 0;
  // Sliding 24-hour history: a fixed window could admit 2x the configured
  // ceiling in a burst across the reset boundary.
  let dayTimes = [];
  let dayCursor = 0;
  let dayUsed = 0;

  return {
    /**
     * The caller checks the catalog and forwarding gate first. A matching
     * in-flight request shares the one upstream response without paying twice.
     * Nothing persists after all current waiters receive the response.
     */
    run({ client, cameraKey, fetchFrame }) {
      if (
        typeof client !== 'string' ||
        !client ||
        typeof cameraKey !== 'string' ||
        !cameraKey ||
        typeof fetchFrame !== 'function'
      )
        return Promise.resolve(null);

      const existing = pending.get(cameraKey);
      if (existing) {
        stats.coalesced += 1;
        return existing;
      }
      const time = now();
      const until = cooldowns.get(cameraKey);
      if (until !== undefined && time < until) {
        stats.cooldown += 1;
        return Promise.resolve(STREET_VIEW_DEFERRED);
      }
      if (time - minuteStart >= windowMs) {
        minuteStart = time;
        minuteUsed = 0;
      }
      while (
        dayCursor < dayTimes.length &&
        (time < dayTimes[dayCursor] ||
          time - dayTimes[dayCursor] >= dailyWindowMs)
      )
        dayCursor += 1;
      if (dayCursor === dayTimes.length) {
        dayTimes = [];
        dayCursor = 0;
      } else if (dayCursor > 1024 && dayCursor * 2 >= dayTimes.length) {
        dayTimes = dayTimes.slice(dayCursor);
        dayCursor = 0;
      }
      dayUsed = dayTimes.length - dayCursor;
      const recent = clients.get(client);
      const clientUsed =
        recent && time - recent.start < windowMs ? recent.used : 0;
      if (
        !perClientMax ||
        !globalMax ||
        !dailyMax ||
        clientUsed >= perClientMax ||
        minuteUsed >= globalMax ||
        dayUsed >= dailyMax ||
        pending.size >= maxPending
      ) {
        stats.denied += 1;
        return Promise.resolve(STREET_VIEW_DEFERRED);
      }

      // Atomic reservation in a single JS turn; no awaits before charging.
      if (clients.has(client)) clients.delete(client);
      else if (clients.size >= maxTracked)
        clients.delete(clients.keys().next().value);
      clients.set(client, {
        start: clientUsed ? recent.start : time,
        used: clientUsed + 1,
      });
      minuteUsed += 1;
      dayTimes.push(time);
      dayUsed += 1;
      stats.attempts += 1;

      const task = Promise.resolve()
        .then(fetchFrame)
        .catch(() => null)
        .then((result) => {
          if (!result?.ok) stats.failures += 1;
          // No success cooldown by default: repeated valid refreshes may
          // spend a fresh admission without retaining Google's image bytes.
          const duration = result?.ok ? successCooldownMs : failureCooldownMs;
          if (cooldowns.has(cameraKey)) cooldowns.delete(cameraKey);
          if (duration > 0) {
            if (cooldowns.size >= maxTracked)
              cooldowns.delete(cooldowns.keys().next().value);
            cooldowns.set(cameraKey, now() + duration);
          }
          return result;
        })
        .finally(() => {
          if (pending.get(cameraKey) === task) pending.delete(cameraKey);
        });
      pending.set(cameraKey, task);
      return task;
    },
    stats() {
      return { ...stats, minuteUsed, dayUsed, pending: pending.size };
    },
  };
}

/** One admission service for every CCTV plugin instance in this process. */
let sharedStreetViewAdmission;
export function processStreetViewAdmission() {
  if (!sharedStreetViewAdmission) {
    sharedStreetViewAdmission = createStreetViewAdmission({
      perClientMax: streetViewCapFromEnv(
        process.env.GEV_CCTV_STREETVIEW_PER_CLIENT_PER_MIN,
        STREET_VIEW_PER_CLIENT_MAX_REQUESTS,
      ),
      globalMax: streetViewCapFromEnv(
        process.env.GEV_CCTV_STREETVIEW_GLOBAL_PER_MIN,
        STREET_VIEW_MAX_REQUESTS,
      ),
      dailyMax: streetViewCapFromEnv(
        process.env.GEV_CCTV_STREETVIEW_DAILY_MAX,
        STREET_VIEW_DAILY_MAX_REQUESTS,
      ),
    });
  }
  return sharedStreetViewAdmission;
}
