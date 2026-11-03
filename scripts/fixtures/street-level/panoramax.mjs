import { tileBounds } from '../../../src/layers/streetLevel/tileMath.js';
import { encodePanoramaxTile } from '../../../src/testSupport/panoramaxFixtures.mjs';
import { metresApart, photoJpeg } from './mapillaryGraph.mjs';

/**
 * Panoramax's meta-catalogue and one instance's pictures answered from
 * fixtures, so the gate's Panoramax steps need no network. Two sequences
 * drive east along the same Paris street (PNX_LINE), their pictures
 * interleaved, so a click on one line must open that line's picture, not
 * the other's that is as near. Every seventh picture of the first is 360°.
 * The meta-catalogue's pictures live on panoramax.openstreetmap.fr; the
 * first sequence is CC BY-SA 4.0 by "Fixture Mapper", the second Licence
 * Ouverte by an account named by an email address (never shown).
 */

export const PNX_SEQUENCES = Object.freeze([
  'a1a1a1a1-0000-4000-8000-000000000001',
  'b2b2b2b2-0000-4000-8000-000000000002',
]);
export const PNX_LINE = Object.freeze({
  lat: 48.8874,
  west: 2.3445,
  east: 2.3545,
});
export const PNX_PARK = Object.freeze({
  lon: 2.3495,
  lat: 48.8874,
  height: 700,
  pitch: -1.4,
});
const PNX_CREATOR = 'Fixture Mapper';
const PNX_SPACING_M = 10;
const METRES_PER_DEG_LON = 111_320 * Math.cos((PNX_LINE.lat * Math.PI) / 180);
const API = 'https://api.panoramax.xyz/api';
const HOST = 'https://panoramax.openstreetmap.fr';

const CORS = Object.freeze({ 'Access-Control-Allow-Origin': '*' });

/** Calls answered since the last reset, by kind. */
let asked = { search: 0, hd: 0 };

export function resetPanoramaxFixture() {
  asked = { search: 0, hd: 0 };
}

/** How many HD originals were downloaded since the last reset. */
export function panoramaxHdDownloads() {
  return asked.hd;
}

/**
 * Both sequences' pictures, west to east. The second's sit 5 m along from
 * the first's, on the same street.
 */
export function panoramaxPictures() {
  const step = PNX_SPACING_M / METRES_PER_DEG_LON;
  const count = Math.floor((PNX_LINE.east - PNX_LINE.west) / step);
  return PNX_SEQUENCES.flatMap((sequenceId, s) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${sequenceId.slice(0, 8)}-${String(i).padStart(4, '0')}`,
      sequenceId,
      index: i,
      count,
      lon: Number((PNX_LINE.west + (i + s / 2) * step).toFixed(7)),
      lat: PNX_LINE.lat,
      isPano: s === 0 && i % 7 === 3,
      datetime:
        s === 0 ? '2025-06-01T10:00:00+00:00' : '2023-03-01T09:00:00+00:00',
    })),
  );
}

function item(picture, pictures) {
  const sibling = (delta) =>
    pictures.find(
      (p) =>
        p.sequenceId === picture.sequenceId &&
        p.index === picture.index + delta,
    );
  const link = (rel, other) =>
    other
      ? [
          {
            rel,
            href: `${API}/collections/${other.sequenceId}/items/${other.id}`,
          },
        ]
      : [];
  const first = picture.sequenceId === PNX_SEQUENCES[0];
  const files = `${HOST}/derivates/${picture.id}`;
  return {
    type: 'Feature',
    id: picture.id,
    collection: picture.sequenceId,
    geometry: { type: 'Point', coordinates: [picture.lon, picture.lat] },
    providers: [
      {
        name: first ? PNX_CREATOR : 'someone@fixture.example.fr',
        roles: ['producer'],
      },
    ],
    properties: {
      datetime: picture.datetime,
      license: first ? 'CC-BY-SA-4.0' : 'etalab-2.0',
      'view:azimuth': 90,
      'pers:interior_orientation': picture.isPano
        ? { field_of_view: 360, sensor_array_dimensions: [5760, 2880] }
        : { field_of_view: 70, sensor_array_dimensions: [4032, 3024] },
    },
    assets: {
      hd: { href: `${files}/hd.jpg` },
      sd: { href: `${files}/sd.jpg` },
      thumb: { href: `${files}/thumb.jpg` },
    },
    links: [
      ...link('prev', sibling(-1)),
      ...link('next', sibling(1)),
      { rel: 'via', href: HOST },
    ],
  };
}

/** The tile `z/x/y` in the meta-catalogue's shape. */
export function panoramaxTile(z, x, y) {
  const tile = { x, y, z };
  const { west, east, south, north } = tileBounds(x, y, z);
  if (PNX_LINE.lat < south || PNX_LINE.lat > north) return new Uint8Array(0);
  const from = Math.max(PNX_LINE.west, west);
  const to = Math.min(PNX_LINE.east, east);
  if (from >= to) return new Uint8Array(0);
  if (z <= 5)
    return encodePanoramaxTile(tile, {
      grid: [{ lon: (from + to) / 2, lat: PNX_LINE.lat, pano: 30, flat: 170 }],
    });
  if (z < 7) return new Uint8Array(0);
  const sequences = PNX_SEQUENCES.map((id, s) => ({
    id,
    type: s === 0 ? 'equirectangular' : 'flat',
    date: s === 0 ? '2025-06-01' : '2023-03-01',
    parts: [
      [
        [from, PNX_LINE.lat],
        [to, PNX_LINE.lat],
      ],
    ],
  }));
  if (z < 15) return encodePanoramaxTile(tile, { sequences });
  const pictures = panoramaxPictures()
    .filter((p) => p.lon >= west && p.lon < east)
    .map((p) => ({
      id: p.id,
      lon: p.lon,
      lat: p.lat,
      sequenceId: p.sequenceId,
      heading: 90,
      ts: p.datetime.replace('T', ' ').replace('+00:00', '+00'),
      type: p.isPano ? 'equirectangular' : 'flat',
    }));
  return encodePanoramaxTile(tile, { sequences, pictures });
}

/** A call named by host, path shape and parameter names. */
export function describePanoramaxCall(method, url) {
  const keys = [...url.searchParams.keys()].sort();
  const path = url.pathname
    .replace(/\/map\/\d+\/\d+\/\d+\.mvt$/, '/map/{z}/{x}/{y}.mvt')
    .replace(
      /^\/derivates\/[\w-]+\/(sd|hd|thumb)\.jpg$/,
      '/derivates/{id}/$1.jpg',
    );
  return `${method} ${url.hostname}${path}${keys.length ? `?${keys.join('&')}` : ''}`;
}

const json = (body) => ({
  status: 200,
  contentType: 'application/geo+json',
  headers: CORS,
  body: JSON.stringify(body),
  known: true,
});

/**
 * Answer one Panoramax request; `known` is false for a call no fixture
 * covers, so the gate fails on a new one instead of missing it.
 */
export function answerPanoramaxRequest({ method, url }) {
  const address = new URL(url);
  if (method === 'OPTIONS')
    return { status: 204, headers: CORS, body: '', known: true };
  const pictures = panoramaxPictures();
  if (address.hostname === new URL(HOST).hostname) {
    const file = address.pathname.match(
      /^\/derivates\/([\w-]+)\/(sd|hd|thumb)\.jpg$/,
    );
    if (!file || !pictures.some((p) => p.id === file[1]))
      return { status: 404, headers: CORS, body: '', known: false };
    if (file[2] === 'hd') asked.hd++;
    return {
      status: 200,
      contentType: 'image/jpeg',
      headers: CORS,
      body: photoJpeg(),
      known: true,
    };
  }
  if (address.hostname !== 'api.panoramax.xyz')
    return { status: 404, headers: CORS, body: '', known: false };
  const tile = address.pathname.match(/^\/api\/map\/(\d+)\/(\d+)\/(\d+)\.mvt$/);
  if (tile) {
    const bytes = panoramaxTile(
      Number(tile[1]),
      Number(tile[2]),
      Number(tile[3]),
    );
    return bytes.length
      ? {
          status: 200,
          contentType: 'application/vnd.mapbox-vector-tile',
          headers: CORS,
          body: Buffer.from(bytes),
          known: true,
        }
      : { status: 204, headers: CORS, body: '', known: true };
  }
  if (address.pathname !== '/api/search')
    return { status: 404, headers: CORS, body: '', known: false };
  asked.search++;
  const q = address.searchParams;
  if (q.has('ids')) {
    const wanted = q.get('ids').split(',');
    return json({
      type: 'FeatureCollection',
      features: pictures
        .filter((p) => wanted.includes(p.id))
        .map((p) => item(p, pictures)),
    });
  }
  const filter = q.get('filter') || '';
  const since = q.get('datetime')?.split('/')[0];
  const kept = pictures
    .filter(
      (p) => !q.get('collections') || p.sequenceId === q.get('collections'),
    )
    .filter((p) =>
      filter === 'field_of_view=360'
        ? p.isPano
        : filter === 'field_of_view<360'
          ? !p.isPano
          : true,
    )
    .filter((p) => !since || Date.parse(p.datetime) >= Date.parse(since));
  // A box: every picture in it, nearest its centre first, as the live API
  // returns them (roughly: the browser ranks them again).
  if (q.has('bbox')) {
    const [west, south, east, north] = q.get('bbox').split(',').map(Number);
    const centre = { lon: (west + east) / 2, lat: (south + north) / 2 };
    return json({
      type: 'FeatureCollection',
      features: kept
        .filter(
          (p) =>
            p.lon >= west && p.lon <= east && p.lat >= south && p.lat <= north,
        )
        .map((p) => ({ p, metres: metresApart(centre, p) }))
        .sort((a, b) => a.metres - b.metres || a.p.id.localeCompare(b.p.id))
        .slice(0, Number(q.get('limit')) || 10)
        .map(({ p }) => item(p, pictures)),
    });
  }
  const [lon, lat] = (q.get('place_position') || '').split(',').map(Number);
  const radius = Number((q.get('place_distance') || '0-50').split('-')[1]);
  // As the API does, even at the widest tolerance: a place behind a
  // picture (every one looks east) is not in it.
  const facing = (p) => lon >= p.lon - 1e-7;
  const near = kept
    .filter(facing)
    .map((p) => ({ p, metres: metresApart({ lon, lat }, p) }))
    .filter(({ metres }) => metres <= radius)
    .sort((a, b) => a.metres - b.metres)
    .slice(0, Number(q.get('limit')) || 10)
    .map(({ p }) => item(p, pictures));
  return json({ type: 'FeatureCollection', features: near });
}
