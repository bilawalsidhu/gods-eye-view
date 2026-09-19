import {
  epoch,
  finite,
  httpError,
  LiveSourceError,
  providerError,
  providerStatusFromResponse,
  readResponse,
} from './contract.js';
import {
  normalizeAircraftTrack,
  openSkySnapshot,
  readsbSnapshot,
  readsbIdentities,
} from './aircraft.js';
import { normalizeVesselTrack, vesselSnapshot } from './vessels.js';
// Namespace import (vessel source only): the MOVEMENT provider status helpers
// are read through it so this binding can never collide with the named
// contract imports above.
import * as liveContract from './contract.js';

const defaultFetch = (...args) => globalThis.fetch(...args);
const header = (response, name) => response.headers?.get?.(name);

/** Structured MOVEMENT-proxy status fields carried on a snapshot (null-safe). */
function providerFields(status) {
  return {
    providerStatus: status?.status ?? null,
    providerError: status?.error ?? null,
    providerFetchedAtMs: status?.fetchedAtMs ?? null,
    providerSource: status?.source ?? null,
  };
}

/**
 * The proxy's own human reason when it reported a structured status (HTTP
 * 503 + X-Provider-*), the legacy mapping otherwise — so the DATA LAYERS row
 * never reads "HTTP 502". A bounded Retry-After lengthens the client backoff.
 */
function movementError(response, payload, source, legacy = httpError) {
  const error = providerStatusFromResponse(response, payload)
    ? providerError(response, payload, source)
    : legacy(response, source);
  const retryAfterSec = finite(header(response, 'retry-after'));
  if (retryAfterSec != null && retryAfterSec > 0) {
    error.retryAfterMs = Math.min(
      120_000,
      Math.max(error.retryAfterMs, retryAfterSec * 1000),
    );
  }
  return error;
}

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
      if (!response.ok)
        throw movementError(response, payload, 'OpenSky', openSkyError);
      const provider = providerStatusFromResponse(response, payload);
      return {
        ...openSkySnapshot(payload, {
          source:
            header(response, 'x-flight-source') ||
            provider?.source ||
            'OpenSky Network',
          coverage:
            header(response, 'x-flight-coverage') ||
            'worldwide upstream snapshot',
          now: now(),
          stale: provider?.status === 'stale',
        }),
        ...providerFields(provider),
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
      // Classification always wants the whole list, never a scene subset.
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/adsblol/mil',
        { signal },
        'adsb.lol',
      );
      if (!response.ok) throw movementError(response, payload, 'adsb.lol');
      return readsbIdentities(payload);
    },
    async getSnapshot(query = {}, { signal } = {}) {
      // A regional view (the layer sends radiusNm only below 2,000 km camera
      // height) is filtered server-side; the globe view keeps the whole list.
      const params = new URLSearchParams();
      if (
        Number.isFinite(query?.latitude) &&
        Number.isFinite(query?.longitude) &&
        Number.isFinite(query?.radiusNm) &&
        query.radiusNm > 0
      ) {
        params.set('lat', query.latitude.toFixed(4));
        params.set('lon', query.longitude.toFixed(4));
        params.set('radiusNm', String(Math.round(query.radiusNm)));
      }
      const { response, payload } = await readResponse(
        fetchImpl,
        `/api/adsblol/mil${params.size ? '?' + params : ''}`,
        { signal },
        'adsb.lol',
      );
      if (!response.ok) throw movementError(response, payload, 'adsb.lol');
      const provider = providerStatusFromResponse(response, payload);
      const age = finite(header(response, 'x-ads-b-cache-age-ms'));
      const ageMs =
        age != null && age > 0
          ? age
          : provider?.ageSec != null && provider.ageSec > 0
            ? provider.ageSec * 1000
            : 0;
      const stale =
        header(response, 'x-ads-b-cache') === 'STALE' ||
        provider?.status === 'stale';
      return {
        ...readsbSnapshot(payload, {
          observedAtMs: now() - ageMs,
          now: now(),
          stale,
          source: provider?.source || 'adsb.lol',
          coverage:
            header(response, 'x-flight-coverage') ||
            'military upstream snapshot',
        }),
        ...providerFields(provider),
        reason: stale ? provider?.error || null : null,
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

/** `?bbox=` value for a scene box ({ lamin, lomin, lamax, lomax }); null when absent/invalid. */
export function vesselBboxParam(bbox) {
  if (!bbox) return null;
  const values = [bbox.lamin, bbox.lomin, bbox.lamax, bbox.lomax].map(finite);
  if (values.some((value) => value == null)) return null;
  if (values[0] >= values[2] || values[1] >= values[3]) return null;
  return values.map((value) => String(+value.toFixed(4))).join(',');
}

export function createAisStreamSource({
  fetchImpl = defaultFetch,
  apiUrl = '/api/ais-live',
  origin = () => globalThis.location?.origin || 'http://localhost',
} = {}) {
  // Both deployments answer the same route: the Vite dev server through the
  // persistent relay (server/providers/vessels/ais-live.js) and the serverless
  // build through the per-scene collector (server/providers/vessels/
  // ais-serverless.js), which is why the scene bbox travels with the request
  // and the MOVEMENT provider status (X-Provider-*) is read back.
  return {
    label: 'AISStream',
    async getSnapshot({ maxRows = 12000, bbox = null } = {}, { signal } = {}) {
      const url = new URL(apiUrl, origin());
      url.searchParams.set('maxRows', String(maxRows));
      const box = vesselBboxParam(bbox);
      if (box) url.searchParams.set('bbox', box);
      const { response, payload } = await readResponse(
        fetchImpl,
        url.toString(),
        { signal, cache: 'no-store' },
        'AIS live',
      );
      const provider = liveContract.providerStatusFromResponse(
        response,
        payload,
      );
      if (!response.ok) {
        const error = liveContract.providerError(response, payload, 'AIS live');
        const reasons = {
          'missing-key': 'AISSTREAM_API_KEY not set',
          'auth-failed': 'API key rejected — check AISSTREAM_API_KEY',
          unsupported: 'live feed unsupported',
          error: 'feed down',
          closed: 'feed disconnected',
        };
        // A proxy that reports a structured provider reason is the most
        // specific source; the legacy reason map covers the dev relay.
        error.message =
          provider?.error || reasons[payload?.status] || error.message;
        throw error;
      }
      const snapshot = vesselSnapshot(payload);
      return {
        ...snapshot,
        status: response.status,
        stale: snapshot.stale || provider?.status === 'stale',
        providerStatus: provider?.status ?? null,
        providerError: provider?.error ?? null,
        providerFetchedAtMs: provider?.fetchedAtMs ?? null,
        providerSource: provider?.source ?? null,
      };
    },
    async getTrack(reference, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/ais-live/track?mmsi=' + encodeURIComponent(reference),
        { signal },
        'AIS live',
      );
      if (!response.ok) throw httpError(response, 'AIS live');
      return {
        records: normalizeVesselTrack(payload?.samples),
        complete: false,
      };
    },
  };
}
