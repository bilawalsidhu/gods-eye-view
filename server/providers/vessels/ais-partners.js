/**
 * Optional partner feeds: Global Fishing Watch and BarentsWatch.
 *
 * Both are free but credentialed, and both are narrower than AISStream — GFW
 * covers fishing and carrier fleets, BarentsWatch covers Norwegian and Arctic
 * waters. Neither replaces the base feed; they answer questions it cannot.
 *
 * GFW matters here because it publishes AIS-off ("gap") events derived from
 * satellite AIS. The reckoning engine infers that a hull went dark from local
 * evidence; GFW can confirm it against a global view.
 *
 * Every client is inert without credentials and fails soft: a partner outage
 * must never degrade the vessel feed.
 */

const GFW_BASE = 'https://gateway.api.globalfishingwatch.org/v3';
const BW_TOKEN_URL = 'https://id.barentswatch.no/connect/token';
const BW_BASE = 'https://live.ais.barentswatch.no/v1';

export const GFW_DATASETS = Object.freeze({
  identity: 'public-global-vessel-identity:latest',
  gaps: 'public-global-gaps-events:latest',
  encounters: 'public-global-encounters-events:latest',
  loitering: 'public-global-loitering-events:latest',
  portVisits: 'public-global-port-visits-events:latest',
});

const DEFAULT_TIMEOUT_MS = 20000;

/** Bound fetch — undici's throws when detached from globalThis. */
function boundFetch() {
  return (...args) => globalThis.fetch(...args);
}

/**
 * Global Fishing Watch client.
 *
 * Non-commercial use only, per GFW's own terms. Tokens are issued instantly
 * and do not expire.
 */
export function createGfwClient({
  token = process.env.GFW_API_TOKEN || '',
  base = GFW_BASE,
  fetchImpl = boundFetch(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const configured = Boolean(String(token).trim());

  async function request(path, params = {}) {
    if (!configured)
      return { ok: false, error: 'GFW_API_TOKEN not configured' };
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    try {
      const response = await fetchImpl(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return {
          ok: false,
          error: `HTTP ${response.status}`,
          status: response.status,
        };
      }
      return { ok: true, data: await response.json() };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  /** Resolves an MMSI or IMO across GFW's registry fusion. */
  async function searchVessel(query) {
    const result = await request('/vessels/search', {
      query: String(query || '').trim(),
      'datasets[0]': GFW_DATASETS.identity,
      limit: 5,
    });
    if (!result.ok) return result;
    return { ok: true, matches: normalizeVesselMatches(result.data) };
  }

  /**
   * AIS-off events for a vessel — GFW's own record of transponder gaps.
   * `vesselId` is GFW's internal id, obtained from searchVessel.
   */
  async function gapEvents(vesselId, { start, end, limit = 20 } = {}) {
    const result = await request('/events', {
      'datasets[0]': GFW_DATASETS.gaps,
      'vessels[0]': vesselId,
      'start-date': start,
      'end-date': end,
      limit,
      offset: 0,
    });
    if (!result.ok) return result;
    return { ok: true, events: normalizeEvents(result.data) };
  }

  function status() {
    return {
      partner: 'global-fishing-watch',
      configured,
      base,
      nonCommercialOnly: true,
    };
  }

  return { configured, searchVessel, gapEvents, status, request };
}

/** Flattens GFW's registry response into the fields this app displays. */
export function normalizeVesselMatches(payload) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  return entries.map((entry) => {
    const self = entry?.selfReportedInfo?.[0] || {};
    const registry = entry?.registryInfo?.[0] || {};
    return {
      vesselId: entry?.selfReportedInfo?.[0]?.id || entry?.id || '',
      name: registry.shipname || self.shipname || '',
      mmsi: String(registry.ssvid || self.ssvid || ''),
      imo: String(registry.imo || self.imo || ''),
      callSign: registry.callsign || self.callsign || '',
      flag: registry.flag || self.flag || '',
      vesselType: entry?.registryInfo?.[0]?.vesselType || '',
      transmissionStart: self.transmissionDateFrom || '',
      transmissionEnd: self.transmissionDateTo || '',
    };
  });
}

/** Flattens GFW's event response to start/end/position. */
export function normalizeEvents(payload) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  return entries.map((entry) => ({
    id: entry?.id || '',
    type: entry?.type || '',
    start: entry?.start || '',
    end: entry?.end || '',
    lat: entry?.position?.lat ?? null,
    lon: entry?.position?.lon ?? null,
    // Gap events carry the distance and duration the vessel was unobserved.
    durationHours: entry?.gap?.durationHours ?? entry?.durationHours ?? null,
    distanceKm: entry?.gap?.distanceKm ?? null,
  }));
}

/**
 * BarentsWatch client.
 *
 * OAuth2 client credentials against id.barentswatch.no, scope `ais`. Tokens
 * are cached until shortly before expiry — re-authenticating per request would
 * spend more time on auth than on data.
 */
export function createBarentsWatchClient({
  clientId = process.env.BARENTSWATCH_CLIENT_ID || '',
  clientSecret = process.env.BARENTSWATCH_CLIENT_SECRET || '',
  tokenUrl = BW_TOKEN_URL,
  base = BW_BASE,
  fetchImpl = boundFetch(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const configured = Boolean(
    String(clientId).trim() && String(clientSecret).trim(),
  );
  let cachedToken = '';
  let expiresAt = 0;
  let lastError = '';

  async function accessToken() {
    if (!configured) return '';
    // 60s of slack so a token cannot expire mid-flight.
    if (cachedToken && now() < expiresAt - 60000) return cachedToken;
    try {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'ais',
      });
      const response = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        lastError = `token HTTP ${response.status}`;
        return '';
      }
      const json = await response.json();
      cachedToken = String(json?.access_token || '');
      expiresAt = now() + Number(json?.expires_in || 3600) * 1000;
      lastError = '';
      return cachedToken;
    } catch (error) {
      lastError = String(error?.message || error);
      return '';
    }
  }

  /** Latest AIS positions in BarentsWatch's coverage. */
  async function latestPositions() {
    const token = await accessToken();
    if (!token) {
      return {
        ok: false,
        error: lastError || 'BarentsWatch credentials not configured',
      };
    }
    try {
      const response = await fetchImpl(`${base}/latest/combined`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      const json = await response.json();
      return { ok: true, rows: normalizeBarentsWatchRows(json) };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  function status() {
    return {
      partner: 'barentswatch',
      configured,
      base,
      tokenCached: Boolean(cachedToken),
      error: lastError || null,
    };
  }

  return { configured, accessToken, latestPositions, status };
}

/**
 * Maps BarentsWatch rows into the same shape the AIS ingest path expects, so
 * partner positions flow through history, screening and reckoning unchanged.
 */
export function normalizeBarentsWatchRows(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : [];
  const rows = [];
  for (const item of list) {
    const mmsi = String(item?.mmsi ?? '').trim();
    const lat = Number(item?.latitude);
    const lon = Number(item?.longitude);
    if (!mmsi || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    rows.push({
      mmsi,
      lat,
      lon,
      name: String(item?.name || '').trim(),
      speed: numberOrNull(item?.speedOverGround),
      course: numberOrNull(item?.courseOverGround),
      heading: numberOrNull(item?.trueHeading),
      nav_status: numberOrNull(item?.navigationalStatus),
      last_position_UTC: String(item?.msgtime || ''),
      source: 'BarentsWatch',
    });
  }
  return rows;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
