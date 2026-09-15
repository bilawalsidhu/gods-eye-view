import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import {
  cameraDisplayCode,
  fallbackHeadingFromId,
  prioritizeSources,
} from './normalize.js';
import { readResponseJsonCapped } from '../common/http.js';

const BASE = 'https://eismoinfo.lt/eismoinfo-backend';
export const LITHUANIA_CAMERAS_URL = `${BASE}/camera-info-table`;
// Without lks=true this endpoint returns [latitude, longitude]. The camera
// table's x/y fields use LKS-94 metres and must never be treated as degrees.
export const LITHUANIA_LOCATIONS_URL = `${BASE}/layer-static-features/VKR`;
export const LITHUANIA_MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const FRAME_PATH = '/eismoinfo-backend/image-provider/camera/last';
const ANCHORS = [
  { lat: 54.6872, lon: 25.2797 }, // Vilnius
  { lat: 54.8985, lon: 23.9036 }, // Kaunas
  { lat: 55.7033, lon: 21.1443 }, // Klaipeda
  { lat: 55.9349, lon: 23.3137 }, // Siauliai
  { lat: 55.7348, lon: 24.3575 }, // Panevezys
];

/** Join public catalogs by ID; register only the official still endpoint. */
export function lithuaniaCameraToSource(row, feature) {
  const id = String(row?.id ?? '');
  if (!/^[1-9]\d{0,8}$/.test(id) || String(feature?.id) !== id) return null;
  const point = feature?.points?.[0]?.point;
  if (!Array.isArray(point) || point.length !== 2) return null;
  const [lat, lon] = point;
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < 53.8 ||
    lat > 56.5 ||
    lon < 20.8 ||
    lon > 26.9
  )
    return null;
  try {
    const url = new URL(row.image);
    if (
      url.origin !== 'https://eismoinfo.lt' ||
      url.username ||
      url.password ||
      url.pathname !== FRAME_PATH ||
      url.searchParams.get('id') !== id
    )
      return null;
  } catch {
    return null;
  }
  // Reconstruct so extra query parameters cannot alter the request.
  const imageUrl = `https://eismoinfo.lt${FRAME_PATH}?id=${id}`;
  const cameraId = `lithuania-${id}`;
  const name = String(row.name || feature.name || `Lietuva ${id}`)
    .trim()
    .slice(0, 160);
  return {
    id: cameraId,
    name,
    city: 'Lithuania / Lietuva',
    cityId: 'lithuania',
    provider: 'Via Lietuva / Eismoinfo',
    lat,
    lon,
    // No calibrated pose is published; use the app's low-confidence prior.
    headingDeg: fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 145,
    mountHeightM: 8,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'eismoinfo-public',
    credit:
      'Via Lietuva / eismoinfo.lt — periodically updated road-camera stills',
    code: cameraDisplayCode(name.toUpperCase()),
  };
}

async function readCatalog(url) {
  const signal = AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS);
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'manual',
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Catalog HTTP ${response.status}`);
  }
  return readResponseJsonCapped(response, LITHUANIA_MAX_CATALOG_BYTES, signal);
}

/** Two bounded requests per shared catalog refresh, no API key required. */
export async function loadLithuaniaSources() {
  try {
    const [rows, layers] = await Promise.all([
      readCatalog(LITHUANIA_CAMERAS_URL),
      readCatalog(LITHUANIA_LOCATIONS_URL),
    ]);
    if (!Array.isArray(rows) || !Array.isArray(layers)) return [];
    const features = layers.find((layer) => layer?.layer === 'VKR')?.features;
    if (!Array.isArray(features)) return [];
    const locations = new Map(
      features.filter(Boolean).map((feature) => [String(feature.id), feature]),
    );
    const cameras = new Map();
    for (const row of rows) {
      const camera = lithuaniaCameraToSource(
        row,
        locations.get(String(row?.id)),
      );
      if (camera && !cameras.has(camera.id)) cameras.set(camera.id, camera);
    }
    const rawCap = Number(process.env.CCTV_LITHUANIA_MAX_SOURCES || 400);
    const cap = Number.isFinite(rawCap)
      ? Math.max(1, Math.min(1000, Math.floor(rawCap)))
      : 400;
    const sources = prioritizeSources([...cameras.values()], cap, ANCHORS);
    console.log(
      `[CCTV] Loaded Lithuania camera sources: ${cameras.size} (using ${sources.length})`,
    );
    return sources;
  } catch (error) {
    console.warn(
      '[CCTV] Lithuania camera download error:',
      error?.message || error,
    );
    return [];
  }
}
