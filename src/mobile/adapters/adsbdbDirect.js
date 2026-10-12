import { UPSTREAM_NOT_ALLOWED, isUpstreamRefusal } from '../sourcePolicy.js';

/**
 * Keyless on-device adsbdb.com enrichment (callsign → route, hex →
 * aircraft type/registration). Parsing is new here — the only existing
 * implementation lives server-side (`server/providers/aircraft/
 * enrichment.js`, entangled with its disk cache) — with the same semantics:
 * 404 is a known-missing key (null), other failures throw, registry refusal
 * resolves honest unavailable.
 *
 * @module mobile/adapters/adsbdbDirect
 */

/** Callsign → route endpoint root (registry family `adsbdb`). */
export const ADSBDB_CALLSIGN_ROOT = 'https://api.adsbdb.com/v0/callsign/';

/** Hex → aircraft endpoint root (registry family `adsbdb`). */
export const ADSBDB_AIRCRAFT_ROOT = 'https://api.adsbdb.com/v0/aircraft/';

/**
 * Normalize an adsbdb route payload (mirrors the server enrichment proxy).
 * @param {*} json Parsed upstream body.
 * @returns {{ airline: string|null, origin: object, destination: object }|null}
 */
export function parseAdsbdbRoute(json) {
  const route = json?.response?.flightroute;
  if (!route?.origin || !route?.destination) return null;
  const airport = (entry) => ({
    code: entry.iata_code || entry.icao_code || '',
    name: entry.municipality || entry.name || '',
    lat: Number.isFinite(entry.latitude) ? entry.latitude : null,
    lon: Number.isFinite(entry.longitude) ? entry.longitude : null,
  });
  return {
    airline: route.airline?.name || null,
    origin: airport(route.origin),
    destination: airport(route.destination),
  };
}

/**
 * Normalize an adsbdb aircraft payload (mirrors the server enrichment proxy).
 * @param {*} json Parsed upstream body.
 * @returns {{ typeCode: string|null, typeName: string|null, registration: string|null }|null}
 */
export function parseAdsbdbAircraft(json) {
  const aircraft = json?.response?.aircraft;
  if (!aircraft) return null;
  return {
    typeCode: aircraft.icao_type || null,
    typeName:
      aircraft.manufacturer && aircraft.type
        ? `${aircraft.manufacturer} ${aircraft.type}`
        : aircraft.type || null,
    registration: aircraft.registration || null,
  };
}

/**
 * Validate an enrichment key without echoing it (values never enter errors).
 * @param {*} value Raw callsign or hex.
 * @param {string} label Error label (`callsign` or `aircraft hex`).
 * @returns {string} Trimmed key.
 */
function cleanKey(value, label) {
  const key = String(value ?? '').trim();
  if (!key || key.length > 16) throw new TypeError(`A ${label} is required`);
  return key;
}

/**
 * Create the keyless on-device adsbdb enrichment source.
 * @param {{ fetchImpl?: Function }} options Caller-owned transport.
 * @returns {{ lookupRoute: Function, lookupAircraft: Function }}
 */
export function createAdsbdbDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  /**
   * Fetch one adsbdb document: null on 404, parsed JSON otherwise.
   * @param {string} url Upstream URL (key already encoded).
   * @param {AbortSignal|undefined} signal Caller signal.
   * @returns {Promise<*|null>} Parsed body, null when unknown, or an
   *   unavailable marker on registry refusal.
   */
  async function lookup(url, signal) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(url, { signal });
    } catch (error) {
      if (isUpstreamRefusal(error)) {
        return { unavailable: UPSTREAM_NOT_ALLOWED };
      }
      throw error;
    }
    signal?.throwIfAborted();
    if (response.status === 404) {
      await response.body?.cancel?.().catch(() => {});
      return null;
    }
    if (!response.ok) throw new Error(`adsbdb HTTP ${response.status}`);
    const payload = await response.json();
    signal?.throwIfAborted();
    return payload;
  }

  return {
    /**
     * Resolve a callsign to its airline + origin/destination airports.
     * @param {string} callsign Flight callsign.
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<object|null>} Route, null when unknown, or an
     *   unavailable marker on registry refusal.
     */
    async lookupRoute(callsign, { signal } = {}) {
      const key = cleanKey(callsign, 'callsign');
      const payload = await lookup(
        `${ADSBDB_CALLSIGN_ROOT}${encodeURIComponent(key)}`,
        signal,
      );
      if (!payload || payload.unavailable) return payload;
      return parseAdsbdbRoute(payload);
    },
    /**
     * Resolve a 24-bit hex address to aircraft type/registration.
     * @param {string} hex Hex address.
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<object|null>} Aircraft, null when unknown, or an
     *   unavailable marker on registry refusal.
     */
    async lookupAircraft(hex, { signal } = {}) {
      const key = cleanKey(hex, 'aircraft hex');
      const payload = await lookup(
        `${ADSBDB_AIRCRAFT_ROOT}${encodeURIComponent(key)}`,
        signal,
      );
      if (!payload || payload.unavailable) return payload;
      return parseAdsbdbAircraft(payload);
    },
  };
}
