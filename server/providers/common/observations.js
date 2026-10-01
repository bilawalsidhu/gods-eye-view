/**
 * Process-scoped observation bus.
 *
 * Existing providers publish normalized position observations here after a
 * successful upstream read; the history recorder and the alert engine
 * subscribe. Publishing never throws into the provider and never blocks the
 * response: listeners run on a later tick and their errors are logged.
 *
 * Observation shape (all domains):
 *   {
 *     domain: 'air' | 'sea',
 *     id: string,              // icao24 hex (air) or MMSI (sea), lowercase
 *     t: number,               // fix epoch milliseconds (source report time)
 *     lat: number, lon: number,
 *     alt?: number|null,       // metres, geometric when known else barometric
 *     speed?: number|null,     // m/s for air, knots for sea (as published)
 *     course?: number|null,    // degrees true
 *     label?: string|null,     // callsign (air) or vessel name (sea)
 *     squawk?: string|null,    // air only
 *     onGround?: boolean|null, // air only
 *     meta?: object|null,      // small per-domain extras (imo, type, country)
 *   }
 *
 * Only what the public feed already published is carried. Nothing here
 * enriches an observation with owner or operator identity.
 */

/** @type {Set<(batch: object[]) => void>} */
const listeners = new Set();

/**
 * Subscribe to observation batches.
 * @param {(batch: object[]) => void} fn Listener.
 * @returns {() => void} Unsubscribe.
 */
export function onObservations(fn) {
  if (typeof fn !== 'function') throw new TypeError('listener required');
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** @returns {number} Current listener count (for tests and diagnostics). */
export function observationListenerCount() {
  return listeners.size;
}

/**
 * Publish a batch. Cheap no-op when nobody listens.
 * @param {object[]} batch Normalized observations.
 */
export function publishObservations(batch) {
  if (!listeners.size || !Array.isArray(batch) || !batch.length) return;
  setImmediate(() => {
    for (const fn of listeners) {
      try {
        fn(batch);
      } catch (error) {
        console.error('[observations] listener failed:', error?.message);
      }
    }
  });
}

/** @type {object[]} */
let queued = [];
let queueTimer = null;
const QUEUE_FLUSH_MS = 1000;
const QUEUE_MAX = 20000;

/**
 * Queue a single observation for batched publication. Used by streaming
 * feeds (AIS) that deliver one record at a time. Flushes at most once a
 * second; bounded so a stalled consumer cannot grow memory without limit.
 * @param {object} observation Normalized observation.
 */
export function queueObservation(observation) {
  if (!listeners.size || !observation) return;
  if (queued.length >= QUEUE_MAX) queued.shift();
  queued.push(observation);
  if (queueTimer) return;
  queueTimer = setTimeout(() => {
    queueTimer = null;
    const batch = queued;
    queued = [];
    publishObservations(batch);
  }, QUEUE_FLUSH_MS);
  queueTimer.unref?.();
}

/**
 * Lazily publish an OpenSky-format states body (also what the adsb.lol
 * fallback normalizes to). Parsing happens off the response path, and only
 * when someone is listening.
 * @param {string} body JSON text of {time, states: [...]}.
 */
export function publishOpenSkyBody(body) {
  if (!listeners.size || typeof body !== 'string') return;
  setImmediate(() => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }
    publishObservations(observationsFromOpenSky(parsed));
  });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Convert an OpenSky states payload to observations.
 * State vector indices: 0 icao24, 1 callsign, 2 origin_country,
 * 3 time_position, 4 last_contact, 5 lon, 6 lat, 7 baro_altitude,
 * 8 on_ground, 9 velocity, 10 true_track, 13 geo_altitude, 14 squawk.
 * @param {{time?: number, states?: any[]}} payload Parsed body.
 * @returns {object[]} Observations.
 */
export function observationsFromOpenSky(payload) {
  const out = [];
  const states = Array.isArray(payload?.states) ? payload.states : [];
  const fallbackSec = num(payload?.time) ?? Math.floor(Date.now() / 1000);
  for (const s of states) {
    if (!Array.isArray(s)) continue;
    const id = typeof s[0] === 'string' ? s[0].trim().toLowerCase() : '';
    const lat = num(s[6]);
    const lon = num(s[5]);
    if (!/^[0-9a-f]{6}$/.test(id) || lat === null || lon === null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const sec = num(s[3]) ?? num(s[4]) ?? fallbackSec;
    const squawk =
      typeof s[14] === 'string' && /^[0-7]{4}$/.test(s[14]) ? s[14] : null;
    out.push({
      domain: 'air',
      id,
      t: Math.round(sec * 1000),
      lat,
      lon,
      alt: num(s[13]) ?? num(s[7]),
      speed: num(s[9]),
      course: num(s[10]),
      label: typeof s[1] === 'string' ? s[1].trim() || null : null,
      squawk,
      onGround: typeof s[8] === 'boolean' ? s[8] : null,
      meta: typeof s[2] === 'string' ? { country: s[2] } : null,
    });
  }
  return out;
}
