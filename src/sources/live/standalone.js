import {
  epoch,
  finite,
  httpError,
  LiveSourceError,
  readResponse,
} from './contract.js';
import {
  normalizeAircraftTrack,
  normalizeAeroApiTrack,
  openSkySnapshot,
  readsbSnapshot,
  readsbIdentities,
} from './aircraft.js';
import { normalizeVesselTrack, vesselSnapshot } from './vessels.js';

const defaultFetch = (...args) => globalThis.fetch(...args);
const header = (response, name) => response.headers?.get?.(name);

function openSkyError(response) {
  const error = httpError(response, 'Flights');
  const mode = String(
    header(response, 'x-opensky-auth-mode-used') ||
      header(response, 'x-opensky-auth') ||
      '',
  ).toLowerCase();
  const reason = String(
    header(response, 'x-opensky-auth-reason') || '',
  ).toLowerCase();
  if (response.status === 429 && (!mode || mode === 'anon'))
    error.message = 'OpenSky rate limited (anonymous)';
  if (response.status === 401 || response.status === 403) {
    const reasons = {
      oauth_invalid_or_missing: 'OpenSky OAuth client missing/invalid',
      oauth_invalid_credentials: 'OpenSky OAuth rejected credentials',
      basic_invalid_credentials: 'OpenSky username/password rejected',
      missing_basic_creds: 'OpenSky auth missing',
      missing_oauth_and_basic_creds: 'OpenSky auth missing',
      auth_required: 'OpenSky auth required',
      forced_anonymous: 'OpenSky auth required',
    };
    error.message =
      reasons[reason] ||
      (/^(oauth_|basic_)/.test(reason)
        ? 'OpenSky auth invalid'
        : mode === 'anon'
          ? 'OpenSky auth required'
          : 'OpenSky auth failed');
  }
  return error;
}

/**
 * The provider a feed response names in `X-Feed-Source`, so a server that
 * answers a feed route from another provider is reported as that provider.
 */
function feedSource(response, fallback) {
  const named = header(response, 'x-feed-source');
  return typeof named === 'string' && named.trim()
    ? named.trim().slice(0, 80)
    : fallback;
}

/** The flights feed (/api/flights); no request starts during construction. */
export function createFlightSource({
  fetchImpl = defaultFetch,
  now = () => Date.now(),
} = {}) {
  return {
    label: 'Flights',
    async getSnapshot(query = {}, { signal } = {}) {
      const params = new URLSearchParams();
      if (Number.isFinite(query.latitude) && Number.isFinite(query.longitude)) {
        params.set('lat', query.latitude.toFixed(4));
        params.set('lon', query.longitude.toFixed(4));
      }
      const { response, payload } = await readResponse(
        fetchImpl,
        `/api/flights${params.size ? '?' + params : ''}`,
        { signal },
        'Flights',
      );
      if (!response.ok) throw openSkyError(response);
      return {
        ...openSkySnapshot(payload, {
          // A fallback provider names itself in X-Flight-Source.
          source:
            header(response, 'x-flight-source') ||
            feedSource(response, 'Flights'),
          coverage:
            header(response, 'x-flight-coverage') ||
            'worldwide upstream snapshot',
          now: now(),
        }),
        status: response.status,
      };
    },
    async getTrack(reference, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/flights/track?icao24=' + encodeURIComponent(reference),
        { signal },
        'Flights',
      );
      if (!response.ok) throw httpError(response, 'Flights');
      return {
        records: normalizeAircraftTrack(payload?.path),
        complete: false,
      };
    },
    async getEnrichment(query, { signal } = {}) {
      if (!['type', 'route'].includes(query.kind))
        throw new LiveSourceError('unsupported', 'Enrichment unavailable');
      const { response, payload } = await readResponse(
        fetchImpl,
        `/api/adsbdb/${query.kind}/${encodeURIComponent(query.id)}`,
        { signal },
        'adsbdb',
      );
      if (!response.ok) throw httpError(response, 'adsbdb');
      return payload;
    },
  };
}

export function createMilitarySource({
  fetchImpl = defaultFetch,
  now = () => Date.now(),
} = {}) {
  return {
    label: 'Military aircraft',
    async getIdentities(_query = {}, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/military',
        { signal },
        'Military aircraft',
      );
      if (!response.ok) throw httpError(response, 'Military aircraft');
      return readsbIdentities(payload);
    },
    async getSnapshot(_query = {}, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/military',
        { signal },
        'Military aircraft',
      );
      if (!response.ok) throw httpError(response, 'Military aircraft');
      const age = finite(header(response, 'x-feed-age-ms'));
      return {
        ...readsbSnapshot(payload, {
          source: feedSource(response, 'Military aircraft'),
          observedAtMs: now() - (age != null && age > 0 ? age : 0),
          now: now(),
          stale: header(response, 'x-feed-cache') === 'STALE',
        }),
        status: response.status,
      };
    },
    async getTrack(reference, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/military/track?hex=' + encodeURIComponent(reference),
        { signal },
        'Military aircraft',
      );
      if (!response.ok) throw httpError(response, 'Military aircraft');
      const baseTimeMs = epoch(payload?.timestamp, 1000);
      return {
        records:
          baseTimeMs == null
            ? []
            : normalizeAircraftTrack(payload?.trace, {
                baseTimeMs,
                readsb: true,
              }),
        complete: false,
      };
    },
  };
}

/**
 * FlightAware AeroAPI historical track lookup (issue #446), resolved through
 * the same-origin /api/aeroapi proxy so the key stays server-side. Mounted as
 * a FALLBACK on the civil flight source: `getTrack` first tries the primary
 * source's own history and only resolves ident → fa_flight_id when that
 * history is exhausted or missing — a failed resolution silently degrades to
 * the local-only trail. Each attempt honors a caller-provided signal.
 */
export function createAeroApiSource({ fetchImpl = defaultFetch } = {}) {
  async function readJson(url, source, signal) {
    const { response, payload } = await readResponse(
      fetchImpl,
      url,
      { signal },
      source,
    );
    if (!response.ok) throw httpError(response, source);
    return payload;
  }

  /**
   * Resolve an ICAO 24-bit address to the fa_flight_id of its most recent
   * position-only/airborne flight. Registration and callsign come from live
   * enrichment and the scheduled-flight window is ±10 days, so the ident
   * variants are queried in parallel and the in-window newest departure wins.
   * Unresolvable inputs (no callsign/registration) throw unsupported.
   */
  async function resolveFlightId(reference, { signal } = {}) {
    const candidates = [reference.registration, reference.callsign].filter(
      (value) => typeof value === 'string' && value.trim(),
    );
    if (!candidates.length)
      throw new LiveSourceError(
        'unsupported',
        'AeroAPI needs a callsign or registration',
      );
    const start = new Date(
      (reference.lastContactEpochMs || Date.now()) - 9.5 * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    const end = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const flightLists = await Promise.allSettled(
      candidates.map((ident) =>
        readJson(
          `/api/aeroapi/flights/${encodeURIComponent(ident.trim())}` +
            `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
          'AeroAPI',
          signal,
        ),
      ),
    );
    const flights = flightLists
      .flatMap((settled) =>
        settled.status === 'fulfilled' ? (settled.value.flights ?? []) : [],
      )
      .filter((flight) => typeof flight?.fa_flight_id === 'string')
      .sort(
        (a, b) =>
          Date.parse(b?.scheduled_out ?? '') -
          Date.parse(a?.scheduled_out ?? ''),
      );
    const flightId = flights[0]?.fa_flight_id;
    if (!flightId)
      throw new LiveSourceError(
        'unavailable',
        'AeroAPI has no recent flight for this aircraft',
      );
    return flightId;
  }

  return {
    label: 'FlightAware AeroAPI',
    /** Registered into the Data-attribution popover when history resolves. */
    credit: {
      key: 'flightaware-aeroapi',
      html:
        'Historical flight tracks: ' +
        '<a href="https://www.flightaware.com" target="_blank" rel="noopener">FlightAware</a> ' +
        '(AeroAPI)',
    },
    /**
     * History for one aircraft. `reference` is the layer's shared-contract
     * record ({ id, callsign, registration, lastContactEpochMs }); a plain
     * string (raw icao24) has no ident to resolve and fails unsupported.
     */
    async getTrackByQuery(reference, { signal } = {}) {
      const flightId = await resolveFlightId(reference ?? {}, { signal });
      const payload = await readJson(
        `/api/aeroapi/flights/${encodeURIComponent(flightId)}/track`,
        'AeroAPI',
        signal,
      );
      return { records: normalizeAeroApiTrack(payload), complete: false };
    },
    /** getTrack-contract shape so a composeSource consumer works unchanged. */
    async getTrack(reference, options = {}) {
      const resolved =
        typeof reference === 'string' ? { id: reference } : (reference ?? {});
      return this.getTrackByQuery(resolved, options);
    },
  };
}

export function createAisStreamSource({
export function createVesselSource({
  fetchImpl = defaultFetch,
  apiUrl = '/api/vessels',
  origin = () => globalThis.location?.origin || 'http://localhost',
} = {}) {
  return {
    label: 'Vessels',
    async getSnapshot({ maxRows = 12000, area } = {}, { signal } = {}) {
      const url = new URL(apiUrl, origin());
      url.searchParams.set('maxRows', String(maxRows));
      // An area asks for the vessels around a point; servers that hold every
      // vessel may ignore it, since callers still keep only what they need.
      if (
        Number.isFinite(area?.lat) &&
        Number.isFinite(area?.lon) &&
        Number.isFinite(area?.radiusKm)
      ) {
        url.searchParams.set('lat', area.lat.toFixed(5));
        url.searchParams.set('lon', area.lon.toFixed(5));
        url.searchParams.set('radius_km', area.radiusKm.toFixed(1));
      }
      const { response, payload } = await readResponse(
        fetchImpl,
        url.toString(),
        { signal, cache: 'no-store' },
        'Vessels',
      );
      if (!response.ok) {
        const error = httpError(response, 'Vessels');
        const reasons = {
          'missing-key': 'AISSTREAM_API_KEY not set',
          'auth-failed': 'API key rejected — check AISSTREAM_API_KEY',
          unsupported: 'live feed unsupported',
          error: 'feed down',
          closed: 'feed disconnected',
        };
        error.message = reasons[payload?.status] || error.message;
        throw error;
      }
      return {
        ...vesselSnapshot(payload, { source: feedSource(response, 'Vessels') }),
        status: response.status,
      };
    },
    async getTrack(reference, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/vessels/track?mmsi=' + encodeURIComponent(reference),
        { signal },
        'Vessels',
      );
      if (!response.ok) throw httpError(response, 'Vessels');
      return {
        records: normalizeVesselTrack(payload?.samples),
        complete: false,
      };
    },
  };
}
