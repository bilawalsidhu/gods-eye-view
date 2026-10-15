import fs from 'node:fs';
import path from 'node:path';
import { fetchCctvImageFromUpstream } from './media.js';
import { fallbackHeadingFromId } from './normalize.js';

const CAMERA_IDS = new Set([
  'cam001',
  'cam002',
  'cam003',
  'cam004',
  'cam005',
  'cam008',
  'cam016',
  'cam017',
  'cam018',
  'cam031',
  'cam032',
]);
const CENTERS = {
  catedral: {
    name: 'Cerro Catedral',
    city: 'Bariloche, Argentina',
    bounds: [-41.21, -71.53, -41.13, -71.4],
  },
  chapelco: {
    name: 'Chapelco',
    city: 'San Martín de los Andes, Argentina',
    bounds: [-40.27, -71.4, -40.17, -71.29],
  },
  lahoya: {
    name: 'La Hoya',
    city: 'Esquel, Argentina',
    bounds: [-42.92, -71.32, -42.75, -71.18],
  },
};
const imageUrl = (id) => 'https://varitech.ar/cameras/' + id + '/latest.jpg';
const IMAGE_URLS = new Set([...CAMERA_IDS].map(imageUrl));

/**
 * Load published Varitech snapshots. Coordinates locate named resort areas,
 * not surveyed camera mounts; both the label and credit retain that distinction.
 * Feed URLs are constructed from known IDs, never read from catalog URL fields.
 */
export function loadVaritechSourcesFromCatalog({
  sourceRoot = process.cwd(),
} = {}) {
  let rows;
  try {
    rows = JSON.parse(
      fs.readFileSync(
        path.resolve(sourceRoot, 'config/cctv_sources.varitech.json'),
        'utf8',
      ),
    );
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const cameras = [];
  for (const row of rows) {
    if (!row || !CAMERA_IDS.has(row.id) || seen.has(row.id)) continue;
    const center =
      typeof row.center === 'string' && Object.hasOwn(CENTERS, row.center)
        ? CENTERS[row.center]
        : null;
    if (!center || typeof row.name !== 'string' || !row.name.trim()) continue;
    const { lat, lon } = row;
    const [south, west, north, east] = center.bounds;
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < south ||
      lat > north ||
      lon < west ||
      lon > east
    )
      continue;
    seen.add(row.id);
    const id = 'varitech-' + row.id;
    cameras.push({
      id,
      code: row.id.toUpperCase(),
      name: row.name.trim() + ' (approx. location)',
      city: center.city,
      provider: 'Varitech — ' + center.name,
      sourceKind: 'varitech-webcam',
      feedType: 'image',
      url: imageUrl(row.id),
      snapshotUrl: imageUrl(row.id),
      lat,
      lon,
      headingDeg: fallbackHeadingFromId(id),
      headingConfidence: 'low',
      groundElevationM: Number.isFinite(row.groundElevationM)
        ? row.groundElevationM
        : undefined,
      credit:
        'Varitech - varitech.ar · ' +
        center.name +
        ' · 5-minute snapshots · approximate resort-area location',
      license:
        'Varitech terms apply (https://varitech.ar/terminos). Informational ' +
        'media use requires attribution; commercial reuse requires written ' +
        'authorization. Map references: © OpenStreetMap contributors (ODbL).',
    });
  }
  return cameras;
}

/**
 * Demand-only cache for the eleven published JPEGs. Share concurrent reads and
 * retain at most 11 x 2 MiB; failures expire sooner and never serve stale images.
 * Each proxy instance owns its cache. No timers, background polling or archives.
 */
export function createVaritechSnapshotFetcher({
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const cache = new Map();
  return async (url) => {
    if (!IMAGE_URLS.has(url)) return null;
    const previous = cache.get(url);
    if (previous && (previous.pending || now() < previous.expiresAt))
      return previous.promise;
    const entry = { pending: true, expiresAt: 0, promise: null };
    entry.promise = fetchCctvImageFromUpstream(url, {
      fetchImpl,
      maxBytes: 2 * 1024 * 1024,
    }).then((image) => {
      const result =
        image?.contentType.split(';')[0].trim() === 'image/jpeg' ? image : null;
      entry.pending = false;
      entry.expiresAt = now() + (result ? 5 * 60 * 1000 : 30 * 1000);
      return result;
    });
    cache.set(url, entry);
    return entry.promise;
  };
}
