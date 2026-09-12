/** Windy Webcams API v3 adapter for western Switzerland. */

export const WINDY_WEBCAMS_API_URL = 'https://api.windy.com/webcams/api/v3/webcams';
export const WINDY_WEBCAM_REGIONS = Object.freeze(['CH.GE', 'CH.VD', 'CH.VS']);
export const WINDY_FRAME_HOST = 'imgproxy.windy.com';
export const WINDY_FRAME_REFRESH_MS = 5 * 60_000;
export const WINDY_CATALOG_REFRESH_MS = 8 * 60_000;
export const WINDY_ATTRIBUTION = 'Webcams provided by windy.com — add a webcam';

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

export function validWindyFrameUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname === WINDY_FRAME_HOST
      && /^\/_\/(?:preview|thumbnail)\/plain\/(?:current|daylight)\/\d+\/original\.jpe?g$/i.test(url.pathname)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

export function validWindyDetailUrl(value, webcamId) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && ['windy.com', 'www.windy.com'].includes(url.hostname)
      && url.pathname === `/webcams/${webcamId}`
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function fallbackHeading(id) {
  let hash = 2166136261;
  for (const char of id) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 16) * 22.5;
}

export function normalizeWindyWebcams(payload) {
  if (!Array.isArray(payload?.webcams)) return [];
  const cameras = [];
  for (const webcam of payload.webcams) {
    const webcamId = String(webcam?.webcamId ?? '').trim();
    const location = webcam?.location;
    const lat = finite(location?.latitude);
    const lon = finite(location?.longitude);
    if (!/^\d+$/.test(webcamId) || webcam?.status !== 'active') continue;
    if (!WINDY_WEBCAM_REGIONS.includes(String(location?.region_code || '').toUpperCase())) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 45.7 || lat > 47.1 || lon < 5.7 || lon > 8.6) continue;
    const imageUrl = String(webcam?.images?.current?.preview || webcam?.images?.current?.thumbnail || '').trim();
    const detailUrl = String(webcam?.urls?.detail || '').trim();
    if (!validWindyFrameUrl(imageUrl) || !validWindyDetailUrl(detailUrl, webcamId)) continue;
    const id = `windy-${webcamId}`;
    const city = String(location?.city || location?.region || 'Western Switzerland').trim();
    cameras.push({
      id,
      name: String(webcam?.title || `Windy webcam ${webcamId}`).trim(),
      city,
      cityId: city.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      provider: 'Windy Webcams',
      lat,
      lon,
      headingDeg: fallbackHeading(id),
      headingConfidence: 'low',
      pitchDeg: -12,
      fovDeg: 60,
      rangeM: 500,
      mountHeightM: 8,
      feedType: 'image',
      cameraType: 'scenic-webcam',
      frameRefreshMs: WINDY_FRAME_REFRESH_MS,
      url: imageUrl,
      snapshotUrl: imageUrl,
      sourcePageUrl: detailUrl,
      sourceKind: 'windy-webcams-api',
      license: WINDY_ATTRIBUTION,
    });
  }
  return Array.from(new Map(cameras.map((camera) => [camera.id, camera])).values());
}

function pageUrl(offset) {
  const url = new URL(WINDY_WEBCAMS_API_URL);
  url.searchParams.set('regions', WINDY_WEBCAM_REGIONS.join(','));
  url.searchParams.set('limit', '50');
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('include', 'categories,images,location,player,urls');
  url.searchParams.set('sortKey', 'popularity');
  url.searchParams.set('sortDirection', 'desc');
  url.searchParams.set('lang', 'en');
  return url.href;
}

export async function loadWindyWebcamSources({ apiKey, fetchImpl = fetch, timeoutMs = 15_000, maxSources = 450 } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) return [];
  const cameras = [];
  try {
    for (let offset = 0; offset < Math.min(1000, maxSources); offset += 50) {
      const response = await fetchImpl(pageUrl(offset), {
        headers: { Accept: 'application/json', 'x-windy-api-key': key },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const page = normalizeWindyWebcams(payload);
      cameras.push(...page);
      const returned = Array.isArray(payload?.webcams) ? payload.webcams.length : 0;
      if (returned < 50 || offset + returned >= Number(payload?.total || 0) || cameras.length >= maxSources) break;
    }
    return Array.from(new Map(cameras.map((camera) => [camera.id, camera])).values()).slice(0, maxSources);
  } catch (error) {
    console.warn('[CCTV] Windy Webcams download error:', error?.message || error);
    return [];
  }
}
