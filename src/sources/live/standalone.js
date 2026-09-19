import {
  epoch,
  finite,
  httpError,
  LiveSourceError,
  readResponse,
} from './contract.js';
import {
  normalizeAircraftTrack,
  openSkySnapshot,
  readsbSnapshot,
  readsbIdentities,
} from './aircraft.js';
import { normalizeVesselTrack, vesselSnapshot } from './vessels.js';

const defaultFetch = (...args) => globalThis.fetch(...args);
const header = (response, name) => response.headers?.get?.(name);

function openSkyError(response) {
  const error = httpError(response, 'OpenSky');
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

/** Existing same-origin aircraft routes; no request starts during construction. */
export function createOpenSkySource({
  fetchImpl = defaultFetch,
  now = () => Date.now(),
} = {}) {
  return {
    label: 'OpenSky Network',
    async getSnapshot(query = {}, { signal } = {}) {
      const params = new URLSearchParams();
      if (Number.isFinite(query.latitude) && Number.isFinite(query.longitude)) {
        params.set('lat', query.latitude.toFixed(4));
        params.set('lon', query.longitude.toFixed(4));
      }
      const { response, payload } = await readResponse(
        fetchImpl,
        `/api/opensky${params.size ? '?' + params : ''}`,
        { signal },
        'OpenSky',
      );
      if (!response.ok) throw openSkyError(response);
      return {
        ...openSkySnapshot(payload, {
          source: header(response, 'x-flight-source') || 'OpenSky Network',
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
        '/api/opensky-track?icao24=' + encodeURIComponent(reference),
        { signal },
        'OpenSky',
      );
      if (!response.ok) throw httpError(response, 'OpenSky');
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

export function createAdsbLolSource({
  fetchImpl = defaultFetch,
  now = () => Date.now(),
} = {}) {
  return {
    label: 'adsb.lol',
    async getIdentities(_query = {}, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/adsblol/mil',
        { signal },
        'adsb.lol',
      );
      if (!response.ok) throw httpError(response, 'adsb.lol');
      return readsbIdentities(payload);
    },
    async getSnapshot(_query = {}, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/adsblol/mil',
        { signal },
        'adsb.lol',
      );
      if (!response.ok) throw httpError(response, 'adsb.lol');
      const age = finite(header(response, 'x-ads-b-cache-age-ms'));
      return {
        ...readsbSnapshot(payload, {
          observedAtMs: now() - (age != null && age > 0 ? age : 0),
          now: now(),
          stale: header(response, 'x-ads-b-cache') === 'STALE',
        }),
        status: response.status,
      };
    },
    async getTrack(reference, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/adsblol/trace?hex=' + encodeURIComponent(reference),
        { signal },
        'adsb.lol',
      );
      if (!response.ok) throw httpError(response, 'adsb.lol');
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

export function createAisStreamSource({
  fetchImpl = defaultFetch,
  apiUrl = '/api/ais-live',
  origin = () => globalThis.location?.origin || 'http://localhost',
} = {}) {
  return {
    label: 'AISStream',
    async getSnapshot({ maxRows = 12000 } = {}, { signal } = {}) {
      const url = new URL(apiUrl, origin());
      url.searchParams.set('maxRows', String(maxRows));
      const { response, payload } = await readResponse(
        fetchImpl,
        url.toString(),
        { signal, cache: 'no-store' },
        'AIS live',
      );
      if (!response.ok) {
        const error = httpError(response, 'AIS live');
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
      return { ...vesselSnapshot(payload), status: response.status };
    },
    /**
     * Plain-language account of one vessel. Server-side because the "why"
     * comes from voyage history the browser never holds.
     */
    async getNarrative(mmsi, { signal } = {}) {
      const url = new URL(`${apiUrl}/narrative`, origin());
      url.searchParams.set('mmsi', String(mmsi));
      const { response, payload } = await readResponse(
        fetchImpl,
        url.toString(),
        { signal, cache: 'no-store' },
        'AIS narrative',
      );
      if (!response.ok) throw httpError(response, 'AIS narrative');
      return payload;
    },
    /**
     * Vessel track. Defaults to the durable store, which survives restarts and
     * holds weeks rather than the process-local ring buffer's few dozen fixes.
     * Falls back to the in-memory path when durable history is switched off,
     * so a checkout without GEV_AIS_HISTORY still draws a trail.
     */
    /**
     * Searches every vessel the server has heard, not just the rows this
     * browser loaded. Returns [] rather than throwing on a bad query, so a
     * search box can call it on every keystroke.
     */
    async searchVessels(query, { signal, limit = 12 } = {}) {
      const q = String(query || '').trim();
      if (q.length < 2) return [];
      const url = new URL(`${apiUrl}/search`, origin());
      url.searchParams.set('q', q);
      url.searchParams.set('limit', String(limit));
      const { response, payload } = await readResponse(
        fetchImpl,
        url.toString(),
        { signal, cache: 'no-store' },
        'AIS search',
      );
      if (!response.ok) return [];
      const live = Array.isArray(payload?.matches) ? payload.matches : [];
      // Archived hits come from the durable store when the live cache has
      // forgotten a hull (or a restart emptied it). They carry a last-known
      // fix rather than a current one and are flagged, but dropping them is
      // what makes a real vessel name fall through to the geocoder.
      const archived = Array.isArray(payload?.archived) ? payload.archived : [];
      return [...live, ...archived];
    },
    async getTrack(reference, { signal, history = true, limit } = {}) {
      const url = new URL(`${apiUrl}/track`, origin());
      url.searchParams.set('mmsi', String(reference));
      if (history) url.searchParams.set('history', '1');
      if (Number.isFinite(Number(limit)))
        url.searchParams.set('limit', String(Math.round(Number(limit))));
      const { response, payload } = await readResponse(
        fetchImpl,
        url.toString(),
        { signal },
        'AIS live',
      );
      if (!response.ok) throw httpError(response, 'AIS live');
      const samples = normalizeVesselTrack(payload?.samples);
      // The durable route answers with an explicit hint when history is off;
      // retry against the ring buffer rather than drawing nothing.
      if (history && !samples.length && payload?.hint) {
        return this.getTrack(reference, { signal, history: false, limit });
      }
      return {
        records: samples,
        complete: false,
        source: payload?.source || '',
      };
    },
  };
}
