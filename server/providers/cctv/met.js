import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import {
  cameraDisplayCode,
  fallbackHeadingFromId,
  isPlausibleLatLon,
  prioritizeSources,
} from './normalize.js';
import { readResponseTextCapped } from '../common/http.js';

/** MET Norway's public webcam list: one keyless HTML page, marked for free
 * use outside MET's firewall, with each camera's site id, place, position
 * and current still. MET publishes its data and products under NLOD 2.0 and
 * CC BY 4.0. */
export const MET_WEBCAM_CATALOG_URL = 'https://obs-view.met.no/obswebcam/';
/** The only path MET camera frames may come from. */
export const MET_IMAGE_ORIGIN = 'https://obs-view.met.no/obswebcam/last/';
/** The whole list is ~7 KB. */
export const MET_MAX_CATALOG_BYTES = 512 * 1024;
const DEFAULT_MAX_SOURCES = 100;
/** Prioritization anchors, south to north, for when a cap is set. */
const ANCHORS = [
  { lat: 59.9139, lon: 10.7522 }, // Oslo
  { lat: 63.4305, lon: 10.3951 }, // Trondheim
  { lat: 69.6492, lon: 18.9553 }, // Tromsø
  { lat: 78.2232, lon: 15.6267 }, // Longyearbyen
];

/** Mainland Norway plus Svalbard and Jan Mayen, where most MET cameras are. */
export function isLikelyMetCoordinate(lat, lon) {
  return (
    isPlausibleLatLon(lat, lon) &&
    lat >= 57.9 &&
    lat <= 81 &&
    lon >= -9.5 &&
    lon <= 34
  );
}

/** "(mot sørvest)" → 225. MET writes the facing as a Norwegian compass word;
 * "søvest" is a spelling the list uses for sørvest. */
const FACING = {
  nord: 0,
  nordøst: 45,
  øst: 90,
  sørøst: 135,
  sør: 180,
  sørvest: 225,
  søvest: 225,
  vest: 270,
  nordvest: 315,
};

export function metFacingToHeading(location) {
  const match = /\(\s*mot\s+([a-zæøå]+)\s*\)/i.exec(String(location || ''));
  if (!match) return NaN;
  const heading = FACING[match[1].toLowerCase()];
  return heading === undefined ? NaN : heading;
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  aring: 'å',
  Aring: 'Å',
  oslash: 'ø',
  Oslash: 'Ø',
  aelig: 'æ',
  AElig: 'Æ',
};

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, ref) => {
    if (ref[0] !== '#') return ENTITIES[ref] ?? whole;
    const code =
      ref[1] === 'x' || ref[1] === 'X'
        ? parseInt(ref.slice(2), 16)
        : parseInt(ref.slice(1), 10);
    return Number.isInteger(code) && code > 31 && code < 0x110000
      ? String.fromCodePoint(code)
      : '';
  });
}

/** The text after `label:` up to the next tag, entity-decoded. */
function field(block, label) {
  const match = new RegExp(`${label}:([^<]*)<`).exec(block);
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
}

/**
 * Split the list page into one raw entry per camera. Each entry starts at its
 * `Site:` label and runs to the next one, so a camera's own image link is the
 * only one inside its entry.
 *
 * @param {string} html
 * @returns {Array<{site:string, group:string, location:string, lat:number,
 *   lon:number, status:string, image:string}>}
 */
export function parseMetWebcamList(html) {
  const text = String(html || '');
  const starts = [...text.matchAll(/Site:/g)].map((m) => m.index);
  return starts.map((start, i) => {
    const block = text.slice(start, starts[i + 1] ?? text.length);
    const head = /^Site:([^\s<]+)\s*\[([^\]<]*)\]/.exec(block);
    const position = field(block, 'Posisjon').split(/\s+/);
    const image = /<a\s+href=["']?([^"'\s>]+)["']?\s*>/i.exec(block);
    return {
      site: head ? head[1] : '',
      group: head ? decodeEntities(head[2]).trim() : '',
      location: field(block, 'Lokasjon'),
      lat: Number(position[0]),
      lon: Number(position[1]),
      status: field(block, 'Status').toLowerCase(),
      image: image ? image[1] : '',
    };
  });
}

/**
 * One parsed list entry → one catalog source, or null. Entries without a
 * current image (the list marks a camera that has stopped delivering by
 * leaving its image cell empty) are dropped, and the frame must be exactly
 * the camera's own `last/site1_<site>.jpg` on MET's host.
 *
 * @param {object} entry - From parseMetWebcamList.
 * @returns {?object}
 */
export function metCameraToSource(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const site = String(entry.site || '');
  if (!/^webcam_[a-z0-9_]{1,40}$/.test(site)) return null;
  const { lat, lon } = entry;
  if (!isLikelyMetCoordinate(lat, lon)) return null;
  let image;
  try {
    image = new URL(String(entry.image || ''), MET_WEBCAM_CATALOG_URL);
  } catch {
    return null;
  }
  const imageUrl = `${MET_IMAGE_ORIGIN}site1_${site}.jpg`;
  if (image.username || image.password || image.href !== imageUrl) return null;

  const cameraId = `no-met-${site.slice('webcam_'.length)}`;
  const location = String(entry.location || '').trim();
  const place = location.replace(/\s*\(\s*mot\s+[^)]*\)\s*$/i, '').trim();
  const name = (location || site).slice(0, 160);
  const facing = metFacingToHeading(location);
  const hasHeading = Number.isFinite(facing);
  return {
    id: cameraId,
    name,
    // Same country-wide picker category as the Statens vegvesen pack.
    city: 'Norway',
    cityId: 'norway',
    provider: 'MET Norway',
    lat,
    lon,
    // The list states the facing as a compass word ("mot øst"), an 8-point
    // bearing the calibration gizmo refines; otherwise the shared prior.
    headingDeg: hasHeading ? facing : fallbackHeadingFromId(cameraId),
    headingConfidence: hasHeading ? 'high' : 'low',
    // Weather cameras look out over terrain and sky rather than down at a
    // road, so a shallower, wider and longer view than the road packs.
    pitchDeg: -8,
    fovDeg: 60,
    rangeM: 400,
    mountHeightM: 6,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'met-obswebcam',
    license:
      'Data from MET Norway (Norwegian Meteorological Institute), NLOD 2.0 / CC BY 4.0',
    code: cameraDisplayCode((place || name).toUpperCase()),
  };
}

/**
 * Fetch MET Norway's weather-station webcams from the keyless public list.
 * Frames are stills on obs-view.met.no.
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadMetSources() {
  try {
    const endpoint = process.env.CCTV_MET_URL || MET_WEBCAM_CATALOG_URL;
    const resp = await fetch(endpoint, {
      headers: { Accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      console.warn(
        '[CCTV] MET webcam list download failed:',
        resp.status >= 300 && resp.status < 400
          ? 'redirected; redirects are not followed'
          : resp.status,
      );
      return [];
    }
    const html = await readResponseTextCapped(resp, MET_MAX_CATALOG_BYTES);
    const cameras = new Map();
    for (const entry of parseMetWebcamList(html)) {
      const camera = metCameraToSource(entry);
      if (camera && !cameras.has(camera.id)) cameras.set(camera.id, camera);
    }
    const rawCap = Number(
      process.env.CCTV_MET_MAX_SOURCES || DEFAULT_MAX_SOURCES,
    );
    const cap = Number.isFinite(rawCap)
      ? Math.max(1, Math.min(500, Math.floor(rawCap)))
      : DEFAULT_MAX_SOURCES;
    const sources = prioritizeSources([...cameras.values()], cap, ANCHORS);
    console.log(
      `[CCTV] Loaded MET webcam sources: ${cameras.size} (using ${sources.length})`,
    );
    return sources;
  } catch (error) {
    console.warn('[CCTV] MET webcam download error:', error?.message || error);
    return [];
  }
}
