import { normalizeAdsbLolPointResponse } from '../../data/adsbLolFallback.js';
import { asUnavailable, isUpstreamRefusal } from '../sourcePolicy.js';
import { KEYED_HTTP_REFUSED, assertKeyedHttps } from '../governors.js';

/**
 * Keyed on-device flights: OpenSky global states (anonymous first, OAuth
 * bearer when the vault holds `OPENSKY_CLIENT_ID` + `OPENSKY_CLIENT_SECRET`)
 * with the viewport-scoped adsb.lol point query as the regional fallback.
 *
 * Auth mirrors the server proxy's OAuth mode: `client_credentials` against
 * the OpenSky Keycloak realm, the bearer cached with a 60s safety margin.
 * The anonymous attempt goes first so a keyless install never pays a token
 * round-trip; a 401/403 retries once with the bearer. Snapshots whose source
 * epoch is older than `OPENSKY_SOURCE_STALE_MS`, and any upstream failure
 * with a view anchor, resolve through adsb.lol (normalized with the shared
 * `normalizeAdsbLolPointResponse`, so the renderer sees the same
 * OpenSky-compatible shape either way).
 *
 * Late responses are discarded: the caller signal is checked after every
 * await, because CapacitorHttp cannot cancel in flight. Keyed URLs must be
 * HTTPS (`assertKeyedHttps`), refused before any transport call.
 *
 * @module mobile/adapters/flightsDirect
 */

/** OpenSky global snapshot (same URL the server proxy fetches). */
export const OPENSKY_STATES_URL =
  'https://opensky-network.org/api/states/all?extended=1';

/** OpenSky OAuth2 `client_credentials` token endpoint. */
export const OPENSKY_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

/** adsb.lol regional point-query radius, matching the server fallback. */
export const ADSB_LOL_POINT_RADIUS_NM = 250;

/** adsb.lol point-query response ceiling. */
export const ADSB_LOL_POINT_CAP_BYTES = 8 * 1024 * 1024;

/**
 * A 200 response can still carry an old OpenSky snapshot. Past this age the
 * viewport-scoped adsb.lol source is more honest (same rule as the proxy).
 */
export const OPENSKY_SOURCE_STALE_MS = 120_000;

/**
 * Build one adsb.lol viewport point-query URL.
 * @param {number} latitude View anchor latitude.
 * @param {number} longitude View anchor longitude.
 * @param {number} radiusNm Radius in nautical miles.
 * @returns {string} Point-query URL.
 */
export function adsbLolPointUrl(
  latitude,
  longitude,
  radiusNm = ADSB_LOL_POINT_RADIUS_NM,
) {
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new TypeError('Valid latitude/longitude are required');
  }
  const roundedLat = Math.round(latitude * 4) / 4;
  const roundedLon = Math.round(longitude * 4) / 4;
  return `https://api.adsb.lol/v2/lat/${roundedLat}/lon/${roundedLon}/dist/${radiusNm}`;
}

/**
 * Create the on-device flights source.
 * @param {{ fetchImpl?: Function, getClientId?: Function, getClientSecret?: Function, governor?: { reportRemaining?: Function, reportRateLimited?: Function }|null, statesUrl?: string, tokenUrl?: string, now?: Function }} options Caller-owned transport, vault readers, credit governor, URL overrides, and clock.
 * @returns {{ getStates: Function, pollDelayMs: Function }} OpenSky-compatible snapshot reader plus the governor's poll delay.
 */
export function createFlightsDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  getClientId = null,
  getClientSecret = null,
  governor = null,
  statesUrl = OPENSKY_STATES_URL,
  tokenUrl = OPENSKY_TOKEN_URL,
  now = () => Date.now(),
} = {}) {
  let token = null;
  let tokenExpiry = 0;

  /**
   * Read the vault OAuth pair. Null unless both halves are present.
   * @returns {Promise<{ id: string, secret: string }|null>} Credentials, or null when keyless.
   */
  async function readCredentials() {
    const [id, secret] = await Promise.all([
      typeof getClientId === 'function' ? getClientId() : null,
      typeof getClientSecret === 'function' ? getClientSecret() : null,
    ]);
    if (
      typeof id !== 'string' ||
      !id ||
      typeof secret !== 'string' ||
      !secret
    ) {
      return null;
    }
    return { id, secret };
  }

  /**
   * Mint (or reuse) the OAuth bearer. Concurrent callers share nothing —
   * the layer polls serially — but the cached token avoids a token
   * round-trip per poll.
   * @param {{ id: string, secret: string }} credentials Vault OAuth pair.
   * @param {AbortSignal} [signal] Caller signal.
   * @returns {Promise<string|null>} Bearer token, or null when minting fails.
   */
  async function readToken(credentials, signal) {
    if (token && now() < tokenExpiry - 60_000) return token;
    assertKeyedHttps(tokenUrl);
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.id,
      client_secret: credentials.secret,
    }).toString();
    const response = await fetchImpl(tokenUrl, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    signal?.throwIfAborted();
    const data = await response.json().catch(() => null);
    signal?.throwIfAborted();
    const accessToken = data?.access_token;
    const expiresIn = Number(data?.expires_in);
    if (!response.ok || typeof accessToken !== 'string' || !accessToken) {
      token = null;
      tokenExpiry = 0;
      return null;
    }
    token = accessToken;
    tokenExpiry =
      now() + (Number.isFinite(expiresIn) ? expiresIn : 1800) * 1000;
    return token;
  }

  /**
   * Fetch the global snapshot with optional bearer auth.
   * @param {string|null} bearer OAuth bearer, or null for anonymous.
   * @param {AbortSignal} [signal] Caller signal.
   * @returns {Promise<Response>} Transport response.
   */
  async function fetchStates(bearer, signal) {
    assertKeyedHttps(statesUrl);
    const headers = { Accept: 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    return fetchImpl(statesUrl, { signal, headers });
  }

  /**
   * Report the credit balance to the governor when the header is present.
   * @param {Response} response Transport response.
   * @returns {Promise<void>}
   */
  async function reportCredits(response) {
    try {
      const remaining = Number(
        response?.headers?.get?.('x-rate-limit-remaining'),
      );
      if (Number.isFinite(remaining))
        await governor?.reportRemaining?.(remaining);
    } catch {
      // Metering must never break the feed it meters.
    }
  }

  /**
   * Resolve the viewport fallback (null without an anchor).
   * @param {number|null} lat View anchor latitude.
   * @param {number|null} lon View anchor longitude.
   * @param {AbortSignal} [signal] Caller signal.
   * @returns {Promise<object|null>} OpenSky-compatible regional snapshot, or null.
   */
  async function adsbLolFallback(lat, lon, signal) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const url = adsbLolPointUrl(lat, lon);
    assertKeyedHttps(url);
    const response = await fetchImpl(url, {
      signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-adsblol-regional-fallback/1.0',
      },
      capBytes: ADSB_LOL_POINT_CAP_BYTES,
    });
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(`adsb.lol HTTP ${response.status}`);
    const normalized = normalizeAdsbLolPointResponse(await response.json());
    signal?.throwIfAborted();
    return { ...normalized, source: 'adsb.lol' };
  }

  return {
    /**
     * Read the current airborne snapshot (OpenSky, or the adsb.lol
     * regional fallback when OpenSky is stale or unreachable).
     * @param {{ lat?: number, lon?: number, signal?: AbortSignal }} options View anchor + caller signal.
     * @returns {Promise<{ time: number, states: Array[], source: string }>} OpenSky-compatible snapshot.
     */
    async getStates({ lat = null, lon = null, signal } = {}) {
      const anchor =
        Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
      signal?.throwIfAborted();
      let response;
      try {
        response = await fetchStates(null, signal);
      } catch (error) {
        if (isUpstreamRefusal(error)) throw asUnavailable(error);
        throw error;
      }
      signal?.throwIfAborted();
      if (response.status === 401 || response.status === 403) {
        const credentials = await readCredentials();
        signal?.throwIfAborted();
        if (credentials) {
          const bearer = await readToken(credentials, signal);
          signal?.throwIfAborted();
          if (bearer) {
            try {
              response = await fetchStates(bearer, signal);
            } catch (error) {
              if (isUpstreamRefusal(error)) throw asUnavailable(error);
              throw error;
            }
            signal?.throwIfAborted();
          }
        } else if (anchor) {
          // Anonymous is rejected and no creds exist: the regional fallback
          // is more honest than an auth error (mirrors the proxy).
          const fallback = await adsbLolFallback(
            anchor.lat,
            anchor.lon,
            signal,
          );
          signal?.throwIfAborted();
          if (fallback) return fallback;
        }
      }
      if (response.status === 429) {
        try {
          await governor?.reportRateLimited?.();
        } catch {
          // Metering must never break the feed it meters.
        }
        if (anchor) {
          const fallback = await adsbLolFallback(
            anchor.lat,
            anchor.lon,
            signal,
          );
          signal?.throwIfAborted();
          if (fallback) return fallback;
        }
        throw new Error('OpenSky rate limited');
      }
      if (!response.ok) {
        if (anchor) {
          const fallback = await adsbLolFallback(
            anchor.lat,
            anchor.lon,
            signal,
          );
          signal?.throwIfAborted();
          if (fallback) return fallback;
        }
        throw new Error(`OpenSky HTTP ${response.status}`);
      }
      await reportCredits(response);
      const payload = await response.json();
      signal?.throwIfAborted();
      if (
        !payload ||
        typeof payload !== 'object' ||
        !Array.isArray(payload.states)
      ) {
        throw new Error('Invalid OpenSky payload');
      }
      const sourceEpochMs =
        Number.isFinite(Number(payload.time)) && Number(payload.time) > 0
          ? Number(payload.time) * 1000
          : null;
      if (
        anchor &&
        Number.isFinite(sourceEpochMs) &&
        now() - sourceEpochMs > OPENSKY_SOURCE_STALE_MS
      ) {
        const fallback = await adsbLolFallback(anchor.lat, anchor.lon, signal);
        signal?.throwIfAborted();
        if (fallback) return fallback;
      }
      return { time: payload.time, states: payload.states, source: 'opensky' };
    },
    /**
     * Milliseconds until the next poll is due per the credit governor
     * (30s healthy default without one).
     * @returns {Promise<number>} Non-negative delay.
     */
    async pollDelayMs() {
      if (governor && typeof governor.pollDelayMs === 'function') {
        return governor.pollDelayMs();
      }
      return 30_000;
    },
  };
}

export { KEYED_HTTP_REFUSED };
