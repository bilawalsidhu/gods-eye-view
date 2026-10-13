import { readFileSync } from 'node:fs';

/**
 * Mapillary Graph API and image CDN answered from fixtures, covering every
 * request the provider and MapillaryJS make while opening and closing a
 * photo, so the gate needs no network and no real token.
 *
 * No `merge_cc` or `sfm_cluster` means MapillaryJS never asks for a mesh or
 * cluster, and empty S2 cells mean no spatial edges, which the gate does not
 * use. The photo is generated for this repository, so it has no third-party
 * licence.
 */

const DAY_MS = 86_400_000;

/** The one sequence with photos: a north-south line through the parked view. */
export const PHOTO_SEQUENCE_ID = 'fx-photo';
export const PHOTO_LINE = Object.freeze({
  lon: -121.4944,
  south: 38.579,
  north: 38.591,
});
/** Metres between consecutive photos on the line (≥ the 3 m cone thinning). */
const PHOTO_SPACING_M = 30;
/** Fixture thumbnail host (answered, never reached). */
export const THUMB_HOST = 'qa-fixture.mapillary.com';

const METRES_PER_DEG_LAT = 110_540;

/**
 * Photos along PHOTO_LINE, south to north; every third one is a panorama.
 * @returns {Array<{id: string, lon: number, lat: number, isPano: boolean, capturedAt: number, compassAngle: number}>}
 */
export function photoImages(now = Date.now()) {
  const step = PHOTO_SPACING_M / METRES_PER_DEG_LAT;
  const count =
    Math.floor((PHOTO_LINE.north - PHOTO_LINE.south) / step + 1e-9) + 1;
  return Array.from({ length: count }, (_, i) => ({
    id: String(9_100_000_000_000 + i),
    lon: PHOTO_LINE.lon,
    lat: Number((PHOTO_LINE.south + i * step).toFixed(7)),
    isPano: i % 3 === 0,
    capturedAt: now - 30 * DAY_MS - i * 1000,
    compassAngle: 0,
  }));
}

const point = (image) => ({
  type: 'Point',
  coordinates: [image.lon, image.lat],
});

/** Every field either caller asks for; extra fields are harmless to both. */
function imageRecord(image) {
  const thumb = `https://${THUMB_HOST}/thumb/${image.id}.jpg`;
  return {
    id: image.id,
    sequence: PHOTO_SEQUENCE_ID,
    geometry: point(image),
    computed_geometry: point(image),
    altitude: 12,
    computed_altitude: 12,
    atomic_scale: 1,
    camera_parameters: image.isPano ? [] : [0.85, 0, 0],
    camera_type: image.isPano ? 'spherical' : 'perspective',
    captured_at: image.capturedAt,
    compass_angle: image.compassAngle,
    computed_compass_angle: image.compassAngle,
    // Angle-axis world-to-camera rotation: +90° about east looks north, level.
    computed_rotation: [Math.PI / 2, 0, 0],
    creator: { id: '1', username: 'qa-fixture' },
    exif_orientation: 1,
    height: 320,
    width: 640,
    is_pano: image.isPano,
    merge_cc: null,
    mesh: null,
    organization: null,
    quality_score: 0.9,
    sfm_cluster: null,
    thumb_256_url: thumb,
    thumb_1024_url: thumb,
    thumb_2048_url: thumb,
  };
}

/** The requested fields plus id, as the Graph API answers. */
function withFields(record, fields) {
  if (!fields) return record;
  const out = { id: record.id };
  for (const field of fields.split(','))
    if (field in record) out[field] = record[field];
  return out;
}

const CORS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type',
  'Access-Control-Max-Age': '600',
});

const json = (status, body) => ({
  status,
  contentType: 'application/json',
  headers: CORS,
  body: JSON.stringify(body),
});

let photoBytes = null;
function photoJpeg() {
  photoBytes ??= readFileSync(new URL('./street-640x320.jpg', import.meta.url));
  return photoBytes;
}

/** Name a call by its parameter names only, so the token is never echoed. */
export function describeCall(method, url) {
  const keys = [...url.searchParams.keys()]
    .filter((key) => key !== 'access_token')
    .sort();
  const path = url.pathname
    .replace(/^\/\d{6,}(?=\/|$)/, '/{imageId}')
    .replace(/^\/thumb\/[\w-]+\.jpg$/, '/thumb/{imageId}.jpg');
  return `${method} ${url.hostname}${path}${keys.length ? `?${keys.join('&')}` : ''}`;
}

/**
 * Answer one Mapillary request. `known` is false for a request no fixture
 * covers, so the gate fails on a new MapillaryJS call instead of missing it.
 * @param {{method: string, url: string, images?: ReturnType<typeof photoImages>}} request
 * @returns {{status: number, contentType?: string, headers?: object, body: string|Buffer, known: boolean}}
 */
export function answerMapillaryRequest({ method, url, images }) {
  const address = new URL(url);
  const photos = images ?? photoImages();
  const byId = new Map(photos.map((image) => [image.id, image]));
  if (method === 'OPTIONS')
    return { status: 204, headers: CORS, body: '', known: true };
  if (address.hostname === THUMB_HOST) {
    if (/^\/thumb\/[\w-]+\.jpg$/.test(address.pathname))
      return {
        status: 200,
        contentType: 'image/jpeg',
        headers: CORS,
        body: photoJpeg(),
        known: true,
      };
    return { ...json(404, { error: 'no such fixture' }), known: false };
  }
  if (address.hostname !== 'graph.mapillary.com')
    return { ...json(404, { error: 'no such fixture host' }), known: false };
  const q = address.searchParams;
  const fields = q.get('fields');
  const path = address.pathname;
  if (path === '/images') {
    if (q.has('image_ids')) {
      const data = q
        .get('image_ids')
        .split(',')
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((image) => withFields(imageRecord(image), fields));
      return { ...json(200, { data }), known: true };
    }
    if (q.has('sequence_ids')) {
      const ids = q.get('sequence_ids').split(',');
      const limit = Number(q.get('limit')) || photos.length;
      const data = ids.includes(PHOTO_SEQUENCE_ID)
        ? photos
            .slice(0, limit)
            .map((image) => withFields(imageRecord(image), fields))
        : [];
      return { ...json(200, { data }), known: true };
    }
    if (q.has('s2')) return { ...json(200, { data: [] }), known: true };
    return {
      ...json(400, { error: 'unsupported images query' }),
      known: false,
    };
  }
  if (path === '/image_ids' && q.has('sequence_id')) {
    const data =
      q.get('sequence_id') === PHOTO_SEQUENCE_ID
        ? photos.map((image) => ({ id: image.id }))
        : [];
    return { ...json(200, { data }), known: true };
  }
  const tiles = path.match(/^\/([\w-]+)\/tiles$/);
  if (tiles) return { ...json(200, { data: [] }), known: true };
  const entity = path.match(/^\/([\w-]+)$/);
  if (entity && byId.has(entity[1]))
    return {
      ...json(200, withFields(imageRecord(byId.get(entity[1])), fields)),
      known: true,
    };
  return { ...json(404, { error: 'no such fixture' }), known: false };
}
