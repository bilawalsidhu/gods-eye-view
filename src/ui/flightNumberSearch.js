import {
  callsignMatchesFlight,
  flightCallsignCandidates,
  parseFlightNumberQuery,
} from '../data/flightNumber.js';

/** Aircraft layers searched for a flight number, in the order they answer. */
export const FLIGHT_SEARCH_LAYERS = Object.freeze(['flights', 'military']);

/** How long one airline code's answer is kept (ms); codes rarely change. */
const AIRLINE_CACHE_MS = 6 * 3600_000;

/**
 * Ask the local adsbdb proxy which airlines hold an IATA (or ICAO) designator.
 * @param {string} code Airline designator.
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{status: 'found', airlines: Array<{name: string|null, icao: string, iata: string|null}>}|{status: 'unknown'}|{status: 'unavailable'}>}
 */
export async function fetchAirlinesByCode(
  code,
  { signal, fetchImpl = globalThis.fetch } = {},
) {
  try {
    const response = await fetchImpl(
      `/api/adsbdb/airline/${encodeURIComponent(code)}`,
      { signal },
    );
    if (!response.ok) return { status: 'unavailable' };
    const body = await response.json();
    if (body?.found !== true) return { status: 'unknown' };
    const airlines = Array.isArray(body.airlines) ? body.airlines : [];
    return airlines.length
      ? { status: 'found', airlines }
      : { status: 'unknown' };
  } catch {
    signal?.throwIfAborted();
    return { status: 'unavailable' };
  }
}

/**
 * Resolve a typed flight number against the aircraft already on the map.
 *
 * Only loaded aircraft are searched and only exact callsigns match, so a
 * found flight is one the operator can follow now. The outcome says why
 * nothing matched, so the search field never reports a missing flight as a
 * missing place, or a layer that is off as an empty sky.
 * @param {object} options
 * @param {(layerId: string) => {enabled: boolean, module: object|null}} options.readLayer
 *   Current state of one aircraft layer.
 * @param {typeof fetchAirlinesByCode} [options.lookupAirlines] Airline lookup.
 * @param {() => number} [options.now] Clock for the airline cache.
 */
export function createFlightNumberSearch({
  readLayer,
  lookupAirlines = fetchAirlinesByCode,
  now = Date.now,
}) {
  const airlineCache = new Map();

  async function airlinesFor(code, signal) {
    const cached = airlineCache.get(code);
    if (cached && cached.expires > now()) return cached.result;
    const result = await lookupAirlines(code, { signal });
    signal?.throwIfAborted();
    // An outage is asked again next time; an answer is kept.
    if (result.status !== 'unavailable') {
      airlineCache.set(code, { result, expires: now() + AIRLINE_CACHE_MS });
      while (airlineCache.size > 64)
        airlineCache.delete(airlineCache.keys().next().value);
    }
    return result;
  }

  return {
    /**
     * @param {string} query Search text.
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<
     *   {status: 'not-flight'} |
     *   {status: 'found', flight: object, layerId: string, match: object} |
     *   {status: 'ambiguous', flight: object, matches: Array<{layerId: string, match: object}>} |
     *   {status: 'none', flight: object, reason: 'layers-off'|'airline-unknown'|'airline-unavailable'|'no-contact'}
     * >}
     */
    async find(query, { signal } = {}) {
      const flight = parseFlightNumberQuery(query);
      if (!flight) return { status: 'not-flight' };
      const layers = FLIGHT_SEARCH_LAYERS.map((layerId) => ({
        layerId,
        ...readLayer(layerId),
      })).filter((layer) => layer.enabled && layer.module);
      if (!layers.length)
        return { status: 'none', flight, reason: 'layers-off' };

      let airlines = [];
      if (flight.kind === 'iata') {
        const answer = await airlinesFor(flight.designator, signal);
        if (answer.status === 'unavailable')
          return { status: 'none', flight, reason: 'airline-unavailable' };
        if (answer.status === 'unknown')
          return { status: 'none', flight, reason: 'airline-unknown' };
        airlines = answer.airlines;
      }
      const candidates = flightCallsignCandidates(flight, airlines);
      if (!candidates.length)
        return { status: 'none', flight, reason: 'airline-unknown' };

      const matches = [];
      const seen = new Set();
      for (const layer of layers) {
        for (const callsign of candidates) {
          // findByQuery ranks an exact callsign first; anything weaker it
          // returns (a prefix, a registration) is not this flight.
          const match = layer.module.findByQuery?.(callsign);
          if (!match || !callsignMatchesFlight(match.callsign, candidates))
            continue;
          if (seen.has(match.icao24)) continue;
          seen.add(match.icao24);
          matches.push({ layerId: layer.layerId, match });
        }
      }
      if (!matches.length)
        return { status: 'none', flight, reason: 'no-contact' };
      if (matches.length > 1) return { status: 'ambiguous', flight, matches };
      return { status: 'found', flight, ...matches[0] };
    },
  };
}
