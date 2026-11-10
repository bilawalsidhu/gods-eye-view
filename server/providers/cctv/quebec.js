import fs from 'node:fs';
import path from 'node:path';
import { cameraDisplayCode, fallbackHeadingFromId } from './normalize.js';

const QUEBEC_CATALOG_PATH = 'public/quebec-cameras.json';
export const QUEBEC_CAMERA_SOURCE_COUNT = 1120;

/**
 * Whether the operator opted in to the browser-direct Québec 511 video. Off by
 * default: the camera locations are CC BY 4.0, but whether Québec 511's
 * service terms allow another site to embed its clips is unconfirmed, so an
 * unset flag lists the cameras with a link to the 511 viewer page only.
 */
export function quebecBrowserVideoEnabled(env = process.env) {
  return String(env.CCTV_QUEBEC_VIDEO_ENABLED || '').trim() === '1';
}

/** Build the direct browser-only MP4 URL for one namespaced MTQ camera id. */
export function quebec511VideoUrl(cameraId) {
  const match = /^qc-511-(\d+)$/.exec(String(cameraId || ''));
  return match
    ? `https://www.quebec511.info/Carte/Fenetres/camera.ashx?id=${match[1]}&format=mp4`
    : '';
}

function safeViewerUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}

function sourceId(camera) {
  const id = String(camera?.id || '').trim();
  if (camera?.kind === 'traffic' && /^\d+$/.test(id)) return `qc-511-${id}`;
  if (camera?.kind === 'montreal' && /^mtl-\d+(?:-\d+)*$/.test(id))
    return `qc-mtl-${id.slice(4)}`;
  if (camera?.kind === 'webcam' && /^web-\d+$/.test(id))
    return `qc-web-${id.slice(4)}`;
  return '';
}

/**
 * Read the checked-in, no-key Québec location catalog and adapt it to the
 * regular CCTV source schema. MTQ video stays browser-only; other rows link to
 * their operator page because this dataset has no direct image URL for them.
 */
export function loadQuebecSources({ sourceRoot = process.cwd() } = {}) {
  const filename = path.resolve(sourceRoot, QUEBEC_CATALOG_PATH);
  let cameras;
  try {
    const payload = JSON.parse(fs.readFileSync(filename, 'utf8'));
    cameras = Array.isArray(payload?.cameras) ? payload.cameras : [];
  } catch (error) {
    console.warn('[CCTV] Québec camera catalog unavailable:', error?.message);
    return [];
  }

  const sources = [];
  const seen = new Set();
  for (const camera of cameras) {
    const id = sourceId(camera);
    const lat = Number(camera.lat);
    const lon = Number(camera.lon);
    if (
      !id ||
      seen.has(id) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < 44.9 ||
      lat > 62.6 ||
      lon < -79.9 ||
      lon > -57.1
    )
      continue;
    seen.add(id);

    const name = String(camera.nameEn || camera.name || id).trim();
    const isTraffic = camera.kind === 'traffic';
    const isMontreal = camera.kind === 'montreal';
    const sourceKind = isTraffic
      ? 'quebec-511-browser'
      : isMontreal
        ? 'quebec-montreal-osm'
        : 'quebec-webcam-link';
    const provider = isTraffic
      ? 'Québec 511 / MTQ'
      : isMontreal
        ? 'Ville de Montréal / OpenStreetMap'
        : String(camera.operator || 'Québec webcam');

    sources.push({
      id,
      name: name.slice(0, 180),
      city: String(camera.region || 'Québec'),
      cityId: 'quebec',
      provider,
      lat,
      lon,
      headingDeg: fallbackHeadingFromId(id),
      headingConfidence: 'low',
      pitchDeg: -18,
      fovDeg: 74,
      rangeM: 400,
      mountHeightM: 8,
      groundElevationM: 0,
      feedType: 'image',
      // No frame URL is registered: the server never fetches 511 media. With
      // CCTV_QUEBEC_VIDEO_ENABLED=1 the browser plays the 511 MP4 in the DOM
      // overlay after a play click; otherwise the camera links to 511.
      url: '',
      snapshotUrl: '',
      sourceKind,
      sourceUrl: safeViewerUrl(camera.viewerUrl),
      accuracyM: Number.isFinite(Number(camera.accuracyM))
        ? Number(camera.accuracyM)
        : null,
      positionSource: String(camera.positionSource || ''),
      license: isTraffic
        ? 'Locations: Données Québec / MTQ, CC BY 4.0. Video: hosted by Québec 511 under its terms of use'
        : isMontreal
          ? 'OpenStreetMap contributors, ODbL 1.0'
          : 'Operator terms apply; location provenance shown per camera',
      credit: isTraffic
        ? 'Locations: MTQ · CC BY 4.0 · Video: Québec 511'
        : isMontreal
          ? 'OpenStreetMap contributors · ODbL'
          : provider,
      code: cameraDisplayCode(name.toUpperCase()),
    });
  }

  return sources;
}
