import {
  readCappedResponseText,
  readResponseJsonCapped,
} from '../common/http.js';
import {
  isPlausibleLatLon,
  toFiniteNumber,
} from './normalize.js';
import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';

const JSON_LIMIT = 8 * 1024 * 1024;
const STATE_BOUNDS = {
  maryland: [37.8, 39.8, -79.6, -74.8],
  connecticut: [40.8, 42.2, -73.8, -71.7],
  georgia: [30.2, 35.1, -85.8, -80.6],
  northCarolina: [33.7, 36.8, -84.5, -75.2],
};

function insideBounds(lat, lon, bounds) {
  return (
    isPlausibleLatLon(lat, lon) &&
    lat >= bounds[0] && lat <= bounds[1] &&
    lon >= bounds[2] && lon <= bounds[3]
  );
}

function cameraRecord({ id, name, city, provider, lat, lon, heading, url, feedType = 'image' }) {
  return {
    id,
    name,
    city,
    cityId: provider.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    provider,
    lat,
    lon,
    headingDeg: heading,
    headingConfidence: Number.isFinite(heading) ? 'high' : '',
    pitchDeg: -8,
    fovDeg: 52,
    rangeM: 420,
    mountHeightM: 8,
    feedType,
    url,
    license: `Official ${provider} public traffic-camera feed`,
    sourceKind: 'open-data',
  };
}

function headingFromText(text) {
  const match = String(text || '').match(/\b(north|south|east|west)(?:bound)?\b/i);
  if (!match) return NaN;
  return ({ north: 0, east: 90, south: 180, west: 270 })[match[1].toLowerCase()];
}

async function fetchJson(url, { headers = {} } = {}) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  return readResponseJsonCapped(response, JSON_LIMIT);
}

function apiUrl(base, key) {
  const url = new URL(base);
  url.searchParams.set('key', key);
  url.searchParams.set('format', 'json');
  return url;
}

function pickEnabledView(views) {
  return (Array.isArray(views) ? views : []).find((view) =>
    String(view?.Status ?? view?.status ?? 'Enabled').toLowerCase() === 'enabled',
  ) || null;
}

async function load511State({
  envKey,
  endpoint,
  state,
  provider,
  prefix,
  bounds,
  imageOrigin,
  maxSources,
}) {
  const key = String(process.env[envKey] || '').trim();
  if (!key) return [];
  try {
    const payload = await fetchJson(apiUrl(endpoint, key));
    const rows = Array.isArray(payload) ? payload : payload?.Cameras || payload?.cameras;
    if (!Array.isArray(rows)) return [];
    const items = [];
    for (const row of rows) {
      const lat = toFiniteNumber(row?.Latitude ?? row?.latitude);
      const lon = toFiniteNumber(row?.Longitude ?? row?.longitude);
      if (!insideBounds(lat, lon, bounds)) continue;
      const view = pickEnabledView(row?.Views ?? row?.views);
      const rawViewId = view?.Id ?? view?.id ?? row?.Id ?? row?.ID ?? row?.id;
      const viewId = String(rawViewId ?? '').trim();
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(viewId)) continue;
      const rawId = String(row?.Id ?? row?.ID ?? row?.id ?? viewId).trim();
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(rawId)) continue;
      const location = String(
        view?.Description ?? view?.description ?? row?.Location ?? row?.Name ?? row?.Roadway ?? `${state} DOT Camera ${rawId}`,
      ).trim().slice(0, 180);
      const direction = String(row?.Direction ?? row?.DirectionOfTravel ?? '').trim();
      const name = [location, direction].filter(Boolean).join(' · ');
      items.push(cameraRecord({
        id: `${prefix}-${rawId}-${viewId}`,
        name,
        city: state,
        provider,
        lat,
        lon,
        heading: headingFromText(direction),
        url: `${imageOrigin}${encodeURIComponent(viewId)}`,
      }));
    }
    return items.slice(0, maxSources);
  } catch {
    // Do not log request errors: keyed endpoints carry the API key in the URL.
    console.warn(`[CCTV] ${provider} camera catalog request failed`);
    return [];
  }
}

/** Public Maryland CHART feed; the official page's player constructs HLS URLs from cctvIp + camera id. */
export async function loadMarylandChartSources() {
  const endpoint = 'https://chartexp1.sha.maryland.gov/CHARTExportClientService/getCameraMapDataJSON.do?callback=gev';
  try {
    const response = await fetch(endpoint, {
      headers: { Accept: 'application/javascript' },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const { tooLarge, text: raw } = await readCappedResponseText(response, JSON_LIMIT);
    if (tooLarge) return [];
    const match = /^\s*gev\((\{[\s\S]*\})\);?\s*$/.exec(raw);
    if (!match) return [];
    const payload = JSON.parse(match[1]);
    const rows = payload?.data;
    if (!Array.isArray(rows)) return [];
    const items = [];
    for (const row of rows) {
      const lat = toFiniteNumber(row?.lat);
      const lon = toFiniteNumber(row?.lon);
      if (!insideBounds(lat, lon, STATE_BOUNDS.maryland)) continue;
      const id = String(row?.id || '').trim();
      const host = String(row?.cctvIp || '').trim().toLowerCase();
      if (!/^[a-f0-9]{16,64}$/i.test(id) || !/^[a-z0-9.-]+\.sha\.maryland\.gov$/.test(host)) continue;
      const name = String(row?.description || row?.name || `Maryland camera ${id}`).trim().slice(0, 180);
      items.push(cameraRecord({
        id: `md-chart-${id}`,
        name,
        city: String(row?.cameraCategories?.[0] || 'Maryland'),
        provider: 'Maryland CHART',
        lat,
        lon,
        heading: NaN,
        url: `https://${host}/rtplive/${encodeURIComponent(id)}/playlist.m3u8`,
        feedType: 'hls',
      }));
    }
    return items.slice(0, 700);
  } catch {
    console.warn('[CCTV] Maryland CHART camera catalog request failed');
    return [];
  }
}

export async function loadConnecticut511Sources() {
  return load511State({
    envKey: 'CCTV_CTROADS_API_KEY',
    endpoint: 'https://ctroads.org/api/getcameras',
    state: 'Connecticut', provider: 'CTroads', prefix: 'ct',
    bounds: STATE_BOUNDS.connecticut,
    imageOrigin: 'https://www.ctroads.org/map/Cctv/', maxSources: 450,
  });
}

export async function loadGeorgia511Sources() {
  return load511State({
    envKey: 'CCTV_511GA_API_KEY',
    endpoint: 'https://511ga.org/api/v2/get/cameras',
    state: 'Georgia', provider: '511GA', prefix: 'ga',
    bounds: STATE_BOUNDS.georgia,
    imageOrigin: 'https://www.511ga.org/map/Cctv/', maxSources: 900,
  });
}

export async function loadDriveNCSources() {
  return load511State({
    envKey: 'CCTV_DRIVENC_API_KEY',
    endpoint: 'https://www.drivenc.gov/api/v2/get/cameras',
    state: 'North Carolina', provider: 'DriveNC', prefix: 'nc',
    bounds: STATE_BOUNDS.northCarolina,
    imageOrigin: 'https://www.drivenc.gov/map/Cctv/', maxSources: 900,
  });
}

function pointInPolygon(lat, lon, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const crosses = (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

// Approximate state boundaries keep the shared New England 511 map catalog
// from mislabelling Vermont cameras as Maine or New Hampshire cameras.
const STATE_POLYGONS = {
  maine: [[-71.1,43.0],[-70.75,43.1],[-70.6,43.35],[-70.5,43.6],[-70.4,43.9],[-70.2,44.1],[-69.9,44.3],[-69.8,44.6],[-69.2,44.8],[-68.9,45.0],[-68.2,45.1],[-67.8,45.2],[-67.0,45.1],[-66.8,45.6],[-67.0,46.0],[-67.1,47.5],[-69.3,47.5],[-70.0,46.8],[-70.4,45.3],[-71.0,45.0],[-71.1,43.0]],
  newHampshire: [[-72.56,42.72],[-72.44,43.0],[-72.2,43.2],[-72.0,43.5],[-71.8,43.8],[-71.6,44.2],[-71.45,44.6],[-71.3,45.0],[-71.0,45.3],[-70.7,45.3],[-70.7,44.1],[-70.8,43.5],[-70.9,43.0],[-71.1,42.7],[-72.56,42.72]],
};

/** Shared public New England 511 catalog; only ME and NH cameras are admitted here. */
export async function loadNewEngland511Sources() {
  const endpoint = 'https://www.newengland511.org/map/mapIcons/Cameras';
  try {
    const payload = await fetchJson(endpoint);
    const rows = payload?.item2;
    if (!Array.isArray(rows)) return [];
    const items = [];
    for (const row of rows) {
      const id = String(row?.itemId || '').trim();
      const lat = toFiniteNumber(row?.location?.[0]);
      const lon = toFiniteNumber(row?.location?.[1]);
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !isPlausibleLatLon(lat, lon)) continue;
      const state = pointInPolygon(lat, lon, STATE_POLYGONS.maine)
        ? 'maine'
        : pointInPolygon(lat, lon, STATE_POLYGONS.newHampshire)
          ? 'newHampshire'
          : '';
      if (!state) continue;
      const stateName = state === 'maine' ? 'Maine' : 'New Hampshire';
      items.push(cameraRecord({
        id: `ne-${state === 'maine' ? 'me' : 'nh'}-${id}`,
        name: String(row?.title || `${stateName} 511 camera ${id}`).trim(),
        city: stateName,
        provider: 'New England 511',
        lat,
        lon,
        heading: NaN,
        url: `https://www.newengland511.org/map/Cctv/${encodeURIComponent(id)}`,
      }));
    }
    return items.slice(0, 900);
  } catch {
    console.warn('[CCTV] New England 511 camera catalog request failed');
    return [];
  }
}
