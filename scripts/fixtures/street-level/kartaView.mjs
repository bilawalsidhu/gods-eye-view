import { deflateSync } from 'node:zlib';
import { tileBounds } from '../../../src/layers/streetLevel/tileMath.js';
import { metresApart, photoJpeg } from './mapillaryGraph.mjs';

/**
 * KartaView's API, image proxy and photo storage answered from fixtures, so
 * the gate's KartaView steps need no network. One drive runs north along
 * KV_LINE; every tenth photo is a 360° one. Photos live on storage2 while
 * their `fileurl*` name storage1, as KartaView's API does, so the gate also
 * proves the provider builds addresses from `storage`. Every odd-indexed
 * photo is archived (storage answers 409, the image proxy still serves it),
 * so the nearest photo opened is even and › must skip the one after it. The
 * first nearest-photo lookup is rate-limited (429, Retry-After: 0), as
 * KartaView does under load.
 *
 * Beside the drive runs KV_OLD_STREET, photographed flat in 2019 only: the
 * imagery filter drops it. KartaView filters coverage only in its PNG
 * tiles, so filtered PNG tiles are drawn here for the streets that pass.
 */

export const KV_SEQUENCE_ID = '900001';
export const KV_LINE = Object.freeze({
  lon: -121.4931,
  south: 38.5795,
  north: 38.5875,
});
/** A street ~130 m east of the drive with only flat 2019 photos. */
export const KV_OLD_STREET = Object.freeze({
  lon: -121.4916,
  south: 38.58,
  north: 38.587,
});
const OLD_STREET_UPLOADED = '2019-06-01';
const KV_SPACING_M = 25;
const METRES_PER_DEG_LAT = 110_540;
/** KartaView's time format for `ms`. */
const kartaViewTime = (ms) =>
  new Date(ms).toISOString().replace('T', ' ').slice(0, 23);
/** The drive is a month old, whenever the gate runs: LAST YEAR keeps it. */
const SHOT = kartaViewTime(Date.now() - 30 * 86_400_000);

const CORS = Object.freeze({ 'Access-Control-Allow-Origin': '*' });

/** Lookups answered so far: the first one is rate-limited. */
let nearestLookups = 0;

/** Forget the lookups answered, so the next one is rate-limited again. */
export function resetKartaViewFixture() {
  nearestLookups = 0;
}

/** Nearest lookups answered since the last reset (the first got a 429). */
export function kartaViewLookups() {
  return nearestLookups;
}

/** The drive's photos, south to north; every tenth is 360°, every odd one archived. */
export function kartaViewPhotos() {
  const step = KV_SPACING_M / METRES_PER_DEG_LAT;
  const count = Math.floor((KV_LINE.north - KV_LINE.south) / step) + 1;
  return Array.from({ length: count }, (_, i) => ({
    id: String(77_000_000 + i),
    index: i,
    lon: KV_LINE.lon,
    lat: Number((KV_LINE.south + i * step).toFixed(7)),
    isPano: i % 10 === 5,
    archived: i % 2 === 1,
  }));
}

function record(photo) {
  const name = `${KV_SEQUENCE_ID}_${photo.id}.jpg`;
  const folder = photo.isPano ? 'wrapped_proc' : 'proc';
  const path = (prefix) => `2024/5/2/${prefix}/${name}`;
  const storage1 = (prefix) =>
    `https://storage1.openstreetcam.org/files/photo/${path(prefix)}`;
  return {
    id: photo.id,
    sequenceId: KV_SEQUENCE_ID,
    sequenceIndex: String(photo.index),
    lat: String(photo.lat),
    lng: String(photo.lon),
    matchLat: String(photo.lat),
    matchLng: String(photo.lon),
    // A dashcam phone's compass, disturbed by the car: the drive runs north.
    heading: '200',
    fieldOfView: photo.isPano ? '360' : '0',
    projection: photo.isPano ? 'SPHERE' : 'PLANE',
    shotDate: SHOT,
    dateAdded: SHOT,
    storage: 'storage2',
    filepath: path('{{sizeprefix}}'),
    filepathLTh: path('lth'),
    filepathProc: path(folder),
    fileurl: storage1('{{sizeprefix}}'),
    fileurlLTh: storage1('lth'),
    fileurlProc: storage1(folder),
  };
}

const ok = (result) => ({
  status: 200,
  contentType: 'application/json',
  headers: CORS,
  body: JSON.stringify({ status: { apiCode: 600, httpCode: 200 }, result }),
});
const raw = (status, body) => ({
  status,
  contentType: 'application/json',
  headers: CORS,
  body: JSON.stringify(body),
});

/** The streets with photos: the drive, and the old street beside it. */
function streets() {
  return [
    { line: KV_LINE, uploaded: SHOT.slice(0, 10), views: ['360', 'plane'] },
    { line: KV_OLD_STREET, uploaded: OLD_STREET_UPLOADED, views: ['plane'] },
  ];
}

/** A street's stretch inside tile `z/x/y`, as [from, to] latitudes, or null. */
function stretch(line, z, x, y) {
  const { west, east, south, north } = tileBounds(x, y, z);
  if (line.lon < west || line.lon > east) return null;
  const from = Math.max(line.south, south);
  const to = Math.min(line.north, north);
  return from < to ? [from, to] : null;
}

/** The streets' tracks inside tile `z/x/y`, as KartaView's JSON tile. */
function tileLines(z, x, y) {
  const lines = [];
  for (const { line } of streets()) {
    const inside = stretch(line, z, x, y);
    if (!inside) continue;
    const [from, to] = inside;
    // Two segments meeting end to start, as KartaView splits ways.
    const mid = (from + to) / 2;
    const at = (lat) => ({ lat: String(lat), lng: String(line.lon) });
    lines.push(
      { track: [at(from), at(mid)], matched: '1' },
      { track: [at(mid), at(to)], matched: '1' },
    );
  }
  return lines;
}

/** Whether a street has photos passing a filtered tile's query. */
function passesTileQuery(street, query) {
  const view = query.get('fieldOfView');
  if (view && !street.views.includes(view)) return false;
  const since = query.get('startDate');
  return !since || street.uploaded >= since;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A filtered coverage tile as KartaView draws it: 512 px, transparent, the
 * passing streets three pixels wide.
 */
export function maskTilePng(z, x, y, query) {
  const size = 512;
  const rgba = Buffer.alloc(size * size * 4);
  const { west, east } = tileBounds(x, y, z);
  const n = 2 ** z;
  const row = (lat) => {
    const sin = Math.sin((lat * Math.PI) / 180);
    const my = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
    return Math.round((my * n - y) * size);
  };
  for (const street of streets()) {
    if (!passesTileQuery(street, query)) continue;
    const inside = stretch(street.line, z, x, y);
    if (!inside) continue;
    const column = Math.round(
      ((street.line.lon - west) / (east - west)) * size,
    );
    const top = Math.max(0, row(inside[1]));
    const bottom = Math.min(size - 1, row(inside[0]));
    for (let py = top; py <= bottom; py++)
      for (let px = column - 1; px <= column + 1; px++) {
        if (px < 0 || px >= size) continue;
        rgba.set([99, 91, 255, 255], (py * size + px) * 4);
      }
  }
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++)
    rgba.copy(
      rows,
      py * (size * 4 + 1) + 1,
      py * size * 4,
      (py + 1) * size * 4,
    );
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A call named by host, path shape and parameter names. */
export function describeKartaViewCall(method, url) {
  const keys = [...url.searchParams.keys()].sort();
  const path = url.pathname
    .replace(/\/tiles\/\d+\/\d+\/\d+\.json$/, '/tiles/{x}/{y}/{z}.json')
    .replace(/\/tiles\/\d+\/\d+\/\d+\.png$/, '/tiles/{x}/{y}/{z}.png')
    .replace(/\/photo\/\d+$/, '/photo/{id}')
    .replace(/\/sequence\/\d+\/photos$/, '/sequence/{id}/photos')
    .replace(/\/sequence\/\d+$/, '/sequence/{id}')
    .replace(/^\/files\/photo\/.*$/, '/files/photo/{path}')
    .replace(
      /^\/pr:sharp\/rs:fit:\d+:\d+\/.*$/,
      '/pr:sharp/rs:fit:{w}:{h}/{address}',
    );
  return `${method} ${url.hostname}${path}${keys.length ? `?${keys.join('&')}` : ''}`;
}

/**
 * Answer one KartaView request; `known` is false for a call no fixture
 * covers, so the gate fails on a new one instead of missing it.
 */
export function answerKartaViewRequest({ method, url }) {
  const address = new URL(url);
  const photos = kartaViewPhotos();
  if (method === 'OPTIONS')
    return { status: 204, headers: CORS, body: '', known: true };
  const image = {
    status: 200,
    contentType: 'image/jpeg',
    headers: CORS,
    body: photoJpeg(),
    known: true,
  };
  if (address.hostname === 'cdn.kartaview.org')
    return /^\/pr:sharp\/rs:fit:\d+:\d+\/[\w-]+$/.test(address.pathname)
      ? image
      : { ...raw(404, {}), known: false };
  if (address.hostname === 'storage2.openstreetcam.org') {
    if (!address.pathname.includes(KV_SEQUENCE_ID))
      return { ...raw(404, {}), known: false };
    const archived = photos.some(
      (photo) =>
        photo.archived && address.pathname.endsWith(`_${photo.id}.jpg`),
    );
    // An archived photo's file is gone from storage: KartaView answers 409.
    return archived ? { ...raw(409, {}), known: true } : image;
  }
  if (/^storage\d+\.openstreetcam\.org$/.test(address.hostname))
    // The wrong host the API names: KartaView answers 404 there.
    return { ...raw(404, {}), known: false };
  if (address.hostname !== 'api.kartaview.org')
    return { ...raw(404, {}), known: false };
  const path = address.pathname;
  const tile = path.match(
    /^\/2\.0\/sequence\/tiles\/(\d+)\/(\d+)\/(\d+)\.json$/,
  );
  if (tile)
    return {
      ...raw(200, {
        lines: tileLines(Number(tile[3]), Number(tile[1]), Number(tile[2])),
      }),
      known: true,
    };
  // Filtered coverage: KartaView filters only its PNG tiles.
  const mask = path.match(
    /^\/2\.0\/sequence\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/,
  );
  if (mask)
    return {
      status: 200,
      contentType: 'image/png',
      headers: CORS,
      body: maskTilePng(
        Number(mask[3]),
        Number(mask[1]),
        Number(mask[2]),
        address.searchParams,
      ),
      known: true,
    };
  if (path === '/2.0/photo/') {
    if (nearestLookups++ === 0)
      return {
        ...raw(429, {}),
        headers: {
          ...CORS,
          'Retry-After': '0',
          'Access-Control-Expose-Headers': 'Retry-After',
        },
        known: true,
      };
    const q = address.searchParams;
    const at = { lat: Number(q.get('lat')), lon: Number(q.get('lng')) };
    // Its own filter, as KartaView's: projection, and upload date.
    const projection = q.get('projection');
    const since = q.get('startDate');
    const near = photos
      .filter(
        (photo) =>
          (!projection || projection === (photo.isPano ? 'SPHERE' : 'PLANE')) &&
          (!since || SHOT.slice(0, 10) >= since),
      )
      .map((photo) => ({ photo, metres: metresApart(at, photo) }))
      .filter(({ metres }) => metres < 200)
      .sort((a, b) => a.metres - b.metres)
      .slice(0, Number(q.get('itemsPerPage')) || 10)
      .map(({ photo, metres }) => ({
        ...record(photo),
        distance: metres.toFixed(2),
      }));
    return { ...ok({ data: near, hasMoreData: false }), known: true };
  }
  const one = path.match(/^\/2\.0\/photo\/(\d+)$/);
  if (one) {
    const photo = photos.find((p) => p.id === one[1]);
    return photo
      ? { ...ok({ data: record(photo) }), known: true }
      : { ...raw(200, { status: { apiCode: 601 }, result: {} }), known: true };
  }
  const sequence = path.match(/^\/2\.0\/sequence\/(\d+)$/);
  if (sequence)
    return {
      ...ok({
        data: {
          id: sequence[1],
          countActivePhotos:
            sequence[1] === KV_SEQUENCE_ID ? String(photos.length) : '0',
        },
      }),
      known: true,
    };
  const page = path.match(/^\/2\.0\/sequence\/(\d+)\/photos$/);
  if (page) {
    const q = address.searchParams;
    const size = Number(q.get('itemsPerPage')) || 100;
    const number = Number(q.get('page')) || 1;
    const rows = page[1] === KV_SEQUENCE_ID ? photos : [];
    return {
      ...ok({
        data: rows.slice((number - 1) * size, number * size).map(record),
        hasMoreData: number * size < rows.length,
      }),
      known: true,
    };
  }
  return { ...raw(404, {}), known: false };
}
