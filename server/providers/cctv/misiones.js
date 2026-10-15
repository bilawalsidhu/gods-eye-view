import fs from 'node:fs';
import path from 'node:path';
import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import { cameraDisplayCode, fallbackHeadingFromId } from './normalize.js';
import { readResponseJsonCapped } from '../common/http.js';

export const MISIONES_CATALOG_URL =
  'https://feeder.camarasdemisiones.com/streams';
export const MISIONES_STREAM_ORIGIN = 'https://stream.camarasdemisiones.com';
export const MISIONES_MAX_CATALOG_BYTES = 256 * 1024;
const MISIONES_MAX_LOCATION_BYTES = 64 * 1024;
export const MISIONES_CAMERAS = Object.freeze({
  cam01: 'Parque Cantera / Puente',
  cam02: 'Arco / Acceso Posadas',
  cam03: 'San José / Centinela',
  cam04: 'Costanera',
  cam05: 'El Brete',
  cam06: 'Punta acceso Puente',
  cam07: 'Zaimán / Puente',
  cam08: 'Andresito',
});

/** Accept installation positions only; never promote a landmark or candidate. */
export function normalizeMisionesLocations(value) {
  if (!Array.isArray(value?.cameras)) return {};
  const locations = {};
  const seen = new Set();
  for (const camera of value.cameras) {
    const id = camera?.camera_id;
    if (!Object.hasOwn(MISIONES_CAMERAS, id)) continue;
    // Ambiguous duplicate identities invalidate the configuration.
    if (seen.has(id)) return {};
    seen.add(id);
    const position = camera.verified_camera_position;
    if (
      !position ||
      position.crs !== 'WGS84' ||
      !Number.isFinite(position.latitude) ||
      !Number.isFinite(position.longitude) ||
      position.latitude < -28.3 ||
      position.latitude > -25.4 ||
      position.longitude < -56.2 ||
      position.longitude > -53.5 ||
      typeof position.verification_source !== 'string' ||
      !position.verification_source.trim()
    )
      continue;
    locations[id] = position;
  }
  return locations;
}

/** Match only the eight reviewed camera paths, excluding TV/radio/embeds. */
export function misionesCameraToSource(row, locationDocument) {
  if (!row || typeof row.url !== 'string') return null;
  const match =
    /^https:\/\/stream\.camarasdemisiones\.com\/(cam0[1-8])\/index\.m3u8$/.exec(
      row.url,
    );
  if (!match) return null;
  const cameraId = match[1];
  const position = normalizeMisionesLocations(locationDocument)[cameraId];
  if (!position) return null;
  // This field has no documented contract. Unknown values do not prove health.
  const status = String(row.status ?? '')
    .trim()
    .toLowerCase();
  if (
    ['0', 'false', 'offline', 'off', 'disabled', 'inactive', 'down'].includes(
      status,
    )
  )
    return null;
  const title =
    typeof row.title === 'string'
      ? row.title
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .trim()
          .slice(0, 120)
      : '';
  const name = title || MISIONES_CAMERAS[cameraId];
  return {
    id: 'misiones-' + cameraId,
    name,
    city: cameraId === 'cam03' ? 'San José' : 'Posadas',
    cityId: 'misiones',
    provider: 'Cámaras de Misiones',
    lat: position.latitude,
    lon: position.longitude,
    // A verified position does not establish camera facing or calibration.
    headingDeg: fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 145,
    mountHeightM: 8,
    feedType: 'hls',
    url: MISIONES_STREAM_ORIGIN + '/' + cameraId + '/index.m3u8',
    snapshotUrl: '',
    sourceKind: 'misiones-public-cameras',
    license: 'Publicly accessible stream; reuse authorization unverified',
    credit: 'Cámaras de Misiones — camarasdemisiones.com',
    code: cameraDisplayCode(cameraId.toUpperCase() + ' ' + name),
  };
}

/** Opt-in acquisition; no upstream request without a verified local position. */
export async function loadMisionesSources({
  sourceRoot = process.cwd(),
  fetchImpl = fetch,
} = {}) {
  if (String(process.env.CCTV_MISIONES_ENABLED || '').trim() !== '1')
    return [];
  const file = process.env.CCTV_MISIONES_LOCATIONS_FILE;
  if (!file) return [];
  try {
    const resolved = path.isAbsolute(file)
      ? file
      : path.resolve(sourceRoot, file);
    if (fs.statSync(resolved).size > MISIONES_MAX_LOCATION_BYTES)
      throw new Error('Misiones location configuration exceeds size cap');
    const locations = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!Object.keys(normalizeMisionesLocations(locations)).length)
      return [];
    const signal = AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS);
    const response = await fetchImpl(MISIONES_CATALOG_URL, {
      redirect: 'error',
      signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-cctv-proxy/1.0',
      },
    });
    if (
      !response.ok ||
      response.redirected ||
      (response.url && response.url !== MISIONES_CATALOG_URL)
    ) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Misiones catalog unavailable');
    }
    const rows = await readResponseJsonCapped(
      response,
      MISIONES_MAX_CATALOG_BYTES,
      signal,
    );
    if (!Array.isArray(rows)) return [];
    const cameras = new Map();
    for (const row of rows) {
      const camera = misionesCameraToSource(row, locations);
      if (camera && !cameras.has(camera.id)) cameras.set(camera.id, camera);
    }
    return [...cameras.values()].sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    console.warn(
      '[CCTV] Misiones catalog or location configuration unavailable',
    );
    return [];
  }
}
