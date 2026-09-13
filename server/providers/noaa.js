import { readResponseTextCapped } from './common/http.js';

const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active?status=actual';
const SPC_REPORTS_URL = 'https://www.spc.noaa.gov/climo/reports/yesterday.csv';
const TTL_MS = 60_000;
const STALE_MAX_MS = 15 * 60_000;
const MAX_ALERT_BYTES = 4 * 1024 * 1024;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_ZONE_BYTES = 1 * 1024 * 1024;
const ZONE_TTL_MS = 6 * 60 * 60_000;

/**
 * NOAA NWS active alerts and SPC preliminary storm reports proxy.
 * Upstream URLs are fixed so this route cannot become an arbitrary relay.
 * Successful responses are cached briefly and stale data is served during
 * transient upstream failures so the client never loses its last good feed.
 * @returns {import('vite').Plugin}
 */
export function noaaHazardsProxy() {
  let cache = null;
  let inflight = null;
  const zoneCache = new Map();

  function collectCoordinates(value, output) {
    if (Array.isArray(value) && value.length >= 2
      && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      output.push([Number(value[0]), Number(value[1])]);
      return;
    }
    if (Array.isArray(value)) for (const child of value) collectCoordinates(child, output);
  }

  function geometryCenter(geometry) {
    const coordinates = [];
    collectCoordinates(geometry?.coordinates, coordinates);
    if (!coordinates.length) return null;
    const lon = coordinates.reduce((sum, point) => sum + point[0], 0) / coordinates.length;
    const lat = coordinates.reduce((sum, point) => sum + point[1], 0) / coordinates.length;
    return Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? [lon, lat] : null;
  }

  async function fetchZoneCenter(url, headers) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.weather.gov'
      || !/^\/zones\/forecast\/[A-Z]{3}\d{3}$/.test(parsed.pathname)) return null;
    const key = parsed.pathname;
    const cached = zoneCache.get(key);
    if (cached && Date.now() - cached.at < ZONE_TTL_MS) return cached.center;
    try {
      const response = await fetch(`https://api.weather.gov${key}`, {
        headers: { Accept: 'application/geo+json, application/json;q=0.9', 'User-Agent': headers['User-Agent'] },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      const zone = JSON.parse(await readResponseTextCapped(response, MAX_ZONE_BYTES));
      const center = geometryCenter(zone?.geometry);
      if (center) zoneCache.set(key, { at: Date.now(), center });
      return center;
    } catch {
      return null;
    }
  }

  async function enrichAlertCenters(alerts, headers) {
    await Promise.all((alerts.features || []).map(async (feature) => {
      if (feature?.geometry || !Array.isArray(feature?.properties?.affectedZones)) return;
      const centers = await Promise.all(
        feature.properties.affectedZones.slice(0, 12).map((url) => fetchZoneCenter(url, headers)),
      );
      const valid = centers.filter(Boolean);
      if (!valid.length) return;
      const lon = valid.reduce((sum, point) => sum + point[0], 0) / valid.length;
      const lat = valid.reduce((sum, point) => sum + point[1], 0) / valid.length;
      feature.geometry = { type: 'Point', coordinates: [lon, lat] };
    }));
  }

  async function fetchUpstream() {
    const headers = {
      Accept: 'application/geo+json, application/json;q=0.9',
      'User-Agent': 'Gods Eye View (public disaster visualization; contact via GitHub repository)',
    };
    const alertsResponse = await fetch(NWS_ALERTS_URL, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!alertsResponse.ok) throw new Error(`NWS HTTP ${alertsResponse.status}`);
    const alertsText = await readResponseTextCapped(alertsResponse, MAX_ALERT_BYTES);
    const alerts = JSON.parse(alertsText);
    if (!Array.isArray(alerts?.features)) throw new Error('NWS response missing features');
    await enrichAlertCenters(alerts, headers);

    let reportsCsv = '';
    try {
      const reportsResponse = await fetch(SPC_REPORTS_URL, {
        headers: {
          Accept: 'text/csv, text/plain;q=0.9',
          'User-Agent': headers['User-Agent'],
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!reportsResponse.ok) throw new Error(`SPC HTTP ${reportsResponse.status}`);
      reportsCsv = await readResponseTextCapped(reportsResponse, MAX_REPORT_BYTES);
      if (!/^Time,F_Scale,Location,County,State,Lat,Lon,Comments/m.test(reportsCsv)) {
        throw new Error('SPC response is not a tornado report CSV');
      }
    } catch (error) {
      console.warn('[noaa-proxy] SPC report refresh failed:', error?.message || error);
    }

    return {
      fetchedAt: Date.now(),
      alerts,
      reportsCsv,
    };
  }

  async function getPayload() {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < TTL_MS) return { ...cache, stale: false };
    if (!inflight) {
      inflight = fetchUpstream()
        .then((fresh) => {
          cache = fresh;
          return { ...fresh, stale: false };
        })
        .catch((error) => {
          console.warn('[noaa-proxy] refresh failed:', error?.message || error);
          if (cache && Date.now() - cache.fetchedAt < STALE_MAX_MS) {
            return { ...cache, stale: true };
          }
          throw error;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  return {
    name: 'noaa-hazards-proxy',
    configureServer(server) {
      server.middlewares.use('/api/noaa/hazards', async (_req, res) => {
        try {
          const payload = await getPayload();
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-NOAA-Hazards': payload.stale ? 'STALE' : 'HIT',
          });
          res.end(JSON.stringify(payload));
        } catch {
          res.writeHead(503, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'NOAA hazards unavailable' }));
        }
      });
    },
  };
}
