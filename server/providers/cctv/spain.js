import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import {
  cameraDisplayCode,
  fallbackHeadingFromId,
  prioritizeSources,
} from './normalize.js';
import { readResponseTextCapped } from '../common/http.js';
import { haversineKm } from '../common/geo.js';

/** DGT (Dirección General de Tráfico) publishes its whole road-camera
 * network as one DATEX II 3.7 document, keyless, refreshed continuously
 * (~1,975 cameras). */
export const SPAIN_DGT_CCTV_URL =
  'https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v37.xml';
/** The document is ~3.8 MB today; keep generous headroom for growth. */
export const SPAIN_MAX_CATALOG_BYTES = 12 * 1024 * 1024;
const DEFAULT_SPAIN_MAX_SOURCES = 800;
/** After a failed download, wait this long before asking again: every attempt
 * holds the shared catalog refresh until the connect timeout. */
export const SPAIN_RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;
/** The document is republished continuously; a good copy stands in for a failed
 * download for up to a day. */
const SPAIN_LAST_GOOD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Only the official DGT frame host and path shape are ever registered; the
// frame proxy refuses to fetch anything else, so a compromised or re-pointed
// catalog cannot turn the app into an open image proxy.
const DGT_FRAME_HOST = 'etraffic.dgt.es';
const DGT_FRAME_PATH = /^\/camarasEtraffic\/[0-9]{1,9}\.jpg$/;

/** Spain, the Balearics, the Canaries, Ceuta and Melilla, with slack. */
export function isLikelySpainCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= 27.4 &&
    lat <= 44.1 &&
    lon >= -18.4 &&
    lon <= 4.6
  );
}

const XML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function codePoint(value, radix) {
  const code = parseInt(value, radix);
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : '';
}

function decodeXml(text) {
  return String(text ?? '')
    .replace(
      /&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#x([0-9a-fA-F]{1,6}));/g,
      (_, name, dec, hex) =>
        name ? XML_ENTITIES[name] : codePoint(dec ?? hex, dec ? 10 : 16),
    )
    .trim();
}

/** DATEX II uses namespace prefixes (`ns2:device`, `loc:latitude`, `fse:deviceUrl`);
 * the prefix set varies between publishers, so match on local names. */
function stripElementPrefixes(xml) {
  return String(xml || '').replace(
    /<(\/?)([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)/g,
    '<$1$3',
  );
}

function firstTag(block, name) {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block);
  return match ? decodeXml(match[1]) : '';
}

/**
 * Parse the DGT DATEX II `device` list into flat camera rows. Regex-based like
 * the Taiwan and Catalonia parsers: the schema is flat, and only the fields
 * used below are read.
 *
 * @param {string} xml
 * @returns {Array<object>}
 */
export function parseSpainDgtXml(xml) {
  const rows = [];
  const normalised = stripElementPrefixes(xml);
  const blockRe = /<device\b([^>]*)>([\s\S]*?)<\/device>/g;
  let match;
  while ((match = blockRe.exec(normalised)) !== null) {
    const attrs = match[1];
    const block = match[2];
    const type = firstTag(block, 'typeOfDevice').toLowerCase();
    if (type !== 'camera') continue;
    const idMatch = /\bid="([^"]*)"/.exec(attrs);
    rows.push({
      deviceId: idMatch ? decodeXml(idMatch[1]) : '',
      lat: Number(firstTag(block, 'latitude')),
      lon: Number(firstTag(block, 'longitude')),
      roadName: firstTag(block, 'roadName'),
      destination: firstTag(block, 'roadDestination'),
      province: firstTag(block, 'province'),
      kilometre: firstTag(block, 'kilometerPoint'),
      frameUrl: firstTag(block, 'deviceUrl'),
    });
  }
  return rows;
}

/**
 * One DGT frame URL, normalised, or null when it is not the published
 * `https://etraffic.dgt.es/camarasEtraffic/<id>.jpg` shape.
 *
 * @param {string} url
 * @returns {?string}
 */
export function spainFrameUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? '').trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== DGT_FRAME_HOST) return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  if (!DGT_FRAME_PATH.test(parsed.pathname)) return null;
  if (parsed.search || parsed.hash) return null;
  return `https://${DGT_FRAME_HOST}${parsed.pathname}`;
}

/**
 * One parsed DGT row -> one catalog source, or null.
 *
 * @param {object} row - Output of parseSpainDgtXml.
 * @returns {?object}
 */
export function spainCameraToSource(row) {
  if (!row || typeof row !== 'object') return null;
  const { lat, lon } = row;
  if (!isLikelySpainCoordinate(lat, lon)) return null;
  const frameUrl = spainFrameUrl(row.frameUrl);
  if (!frameUrl) return null;
  const deviceId = String(row.deviceId ?? '')
    .trim()
    .slice(0, 12);
  if (!/^[0-9]+$/.test(deviceId)) return null;
  const cameraId = `es-dgt-${deviceId}`;
  const road = String(row.roadName ?? '').trim();
  const province = String(row.province ?? '').trim();
  const destination = String(row.destination ?? '').trim();
  const kilometre = String(row.kilometre ?? '').trim();
  const place = province || destination;
  const name =
    [road, kilometre ? `km ${kilometre}` : '', place ? `· ${place}` : '']
      .filter(Boolean)
      .join(' ')
      .trim() || `DGT camera ${deviceId}`;

  return {
    id: cameraId,
    name: name.slice(0, 160),
    // One country-wide category in the camera picker, like Taiwan and Norway.
    city: 'Spain / España',
    cityId: 'spain',
    provider: 'Dirección General de Tráfico (DGT)',
    lat,
    lon,
    // DATEX II publishes the carriageway, not the camera's bearing, so the
    // pose uses the shared low-confidence prior.
    headingDeg: fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 145,
    mountHeightM: 8,
    feedType: 'image',
    url: frameUrl,
    snapshotUrl: frameUrl,
    sourceKind: 'es-dgt-datex2',
    license:
      'Dirección General de Tráfico (DGT) open data, Creative Commons Attribution (CC BY)',
    code: cameraDisplayCode(
      `${road} ${kilometre}`.trim().toUpperCase() || `DGT ${deviceId}`,
    ),
  };
}

/** Two device records can publish the same still. Kept together they would place
 * two confident anchors on one camera, so a shared frame survives only when its
 * devices agree on where the camera is; aliases further apart than this drop the
 * frame altogether. */
const SPAIN_SHARED_FRAME_TOLERANCE_KM = 0.5;

/**
 * Collapse device records that publish one frame URL.
 *
 * Nearby aliases (within the tolerance) keep their first device; aliases that
 * disagree by more than the tolerance drop the shared frame entirely, because
 * which of the two positions is the camera's cannot be told apart.
 *
 * @param {Array<object>} cameras sources from {@link spainCameraToSource}
 * @returns {{cameras: Array<object>, omitted: number}}
 */
export function dedupeSpainCameras(cameras) {
  const byId = new Map();
  for (const camera of cameras) {
    if (!byId.has(camera.id)) byId.set(camera.id, camera);
  }
  const byFrame = new Map();
  for (const camera of byId.values()) {
    const group = byFrame.get(camera.url);
    if (group) group.push(camera);
    else byFrame.set(camera.url, [camera]);
  }
  const kept = [];
  let omitted = 0;
  for (const group of byFrame.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const [primary] = group;
    const disagrees = group.some(
      (camera) =>
        haversineKm(primary.lat, primary.lon, camera.lat, camera.lon) >
        SPAIN_SHARED_FRAME_TOLERANCE_KM,
    );
    if (disagrees) {
      omitted += group.length;
      continue;
    }
    kept.push(primary);
    omitted += group.length - 1;
  }
  return { cameras: kept, omitted };
}

/** Prioritization anchors, mainland plus both archipelagos, so a cap keeps the
 * whole country rather than only the Madrid–Barcelona corridor. */
const ANCHORS = [
  { lat: 40.4168, lon: -3.7038 }, // Madrid
  { lat: 41.3874, lon: 2.1686 }, // Barcelona
  { lat: 39.4699, lon: -0.3763 }, // Valencia
  { lat: 37.3891, lon: -5.9845 }, // Sevilla
  { lat: 43.263, lon: -2.935 }, // Bilbao
  { lat: 42.88, lon: -8.544 }, // Santiago de Compostela
  { lat: 28.4636, lon: -16.2518 }, // Santa Cruz de Tenerife
  { lat: 39.5696, lon: 2.6502 }, // Palma
];

let lastGood = null;
let lastGoodAt = 0;
let retryAfter = 0;

/** Forget the last good table and any failure backoff (tests only). */
export function resetSpainSourcesCache() {
  lastGood = null;
  lastGoodAt = 0;
  retryAfter = 0;
}

function fallbackSources() {
  return lastGood && Date.now() - lastGoodAt <= SPAIN_LAST_GOOD_MAX_AGE_MS
    ? lastGood
    : [];
}

function spainSourceCap() {
  const rawCap = Number(
    process.env.CCTV_SPAIN_MAX_SOURCES || DEFAULT_SPAIN_MAX_SOURCES,
  );
  return Number.isFinite(rawCap)
    ? Math.max(1, Math.min(2000, Math.floor(rawCap)))
    : DEFAULT_SPAIN_MAX_SOURCES;
}

/**
 * Fetch Spain's DGT cameras from the keyless DATEX II document. One bounded
 * request per shared catalog refresh. A failed download serves the last good
 * table (up to a day old) and is retried after 30 minutes.
 *
 * @returns {Promise<Array<object>>}
 */
export async function loadSpainSources() {
  if (Date.now() < retryAfter) return fallbackSources();
  try {
    const signal = AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS);
    const response = await fetch(
      process.env.CCTV_SPAIN_URL || SPAIN_DGT_CCTV_URL,
      {
        headers: { Accept: 'application/xml,text/xml' },
        redirect: 'manual',
        signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        response.status >= 300 && response.status < 400
          ? 'catalog redirected; redirects are not followed'
          : `HTTP ${response.status}`,
      );
    }
    const xml = await readResponseTextCapped(
      response,
      SPAIN_MAX_CATALOG_BYTES,
      signal,
    );
    const parsed = [];
    for (const row of parseSpainDgtXml(xml)) {
      const camera = spainCameraToSource(row);
      if (camera) parsed.push(camera);
    }
    const { cameras, omitted } = dedupeSpainCameras(parsed);
    if (!cameras.length) throw new Error('no usable cameras in the document');
    const sources = prioritizeSources(cameras, spainSourceCap(), ANCHORS);
    console.log(
      `[CCTV] Loaded Spain DGT camera sources: ${cameras.length}` +
        (omitted ? ` (${omitted} shared-frame aliases dropped)` : '') +
        ` (using ${sources.length})`,
    );
    lastGood = sources;
    lastGoodAt = Date.now();
    retryAfter = 0;
    return sources;
  } catch (error) {
    retryAfter = Date.now() + SPAIN_RETRY_AFTER_FAILURE_MS;
    const fallback = fallbackSources();
    console.warn(
      `[CCTV] Spain DGT camera download failed (${error?.message || error}); ` +
        (fallback.length
          ? `serving the last good ${fallback.length} cameras`
          : 'no Spain cameras') +
        ', next attempt in 30 min',
    );
    return fallback;
  }
}
