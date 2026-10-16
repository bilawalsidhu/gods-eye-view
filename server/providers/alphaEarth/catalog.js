import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { asyncBufferFromUrl, parquetReadObjects } from 'hyparquet';

import {
  ALPHA_EARTH_HTTPS_PREFIX,
  ALPHA_EARTH_INDEX_URL,
  ALPHA_EARTH_S3_PREFIX,
} from './constants.js';
import { utmZoneFromCrs } from './grid.js';

const INDEX_COLUMNS = [
  'path',
  'year',
  'crs',
  'utm_west',
  'utm_south',
  'utm_east',
  'utm_north',
  'wgs84_west',
  'wgs84_south',
  'wgs84_east',
  'wgs84_north',
];
const DISK_SCHEMA = 1;
/** The mirror adds one year per release; a week-old index is fresh enough. */
export const ALPHA_EARTH_INDEX_TTL_MS = 7 * 24 * 3600_000;

/** Read the needed index columns straight from the remote GeoParquet by range. */
export async function fetchIndexRows({ url = ALPHA_EARTH_INDEX_URL } = {}) {
  const file = await asyncBufferFromUrl({ url });
  return parquetReadObjects({ file, columns: INDEX_COLUMNS });
}

/** Normalise one index row, or null when it is unusable. */
export function normalizeIndexRow(row) {
  const utm = utmZoneFromCrs(row?.crs);
  const year = Number(row?.year);
  const rawPath = String(row?.path || '');
  if (!utm || !Number.isInteger(year)) return null;
  if (
    !rawPath.startsWith(ALPHA_EARTH_S3_PREFIX) ||
    !rawPath.endsWith('.tiff')
  ) {
    return null;
  }
  const record = {
    key: rawPath.slice(ALPHA_EARTH_S3_PREFIX.length),
    year,
    zone: utm.zone,
    south: utm.south,
    utmWest: Number(row.utm_west),
    utmSouth: Number(row.utm_south),
    utmEast: Number(row.utm_east),
    utmNorth: Number(row.utm_north),
    west: Number(row.wgs84_west),
    southLat: Number(row.wgs84_south),
    east: Number(row.wgs84_east),
    northLat: Number(row.wgs84_north),
  };
  const numeric = [
    record.utmWest,
    record.utmSouth,
    record.utmEast,
    record.utmNorth,
    record.west,
    record.southLat,
    record.east,
    record.northLat,
  ];
  return numeric.every(Number.isFinite) ? record : null;
}

export function cogUrl(record) {
  return `${ALPHA_EARTH_HTTPS_PREFIX}${record.key}`;
}

/**
 * Year-partitioned COG catalog over the mirror's index, loaded once per
 * process (single-flight) with a disk copy under `.gev-cache/` so a restart
 * does not re-read the remote index.
 */
export function createAlphaEarthCatalog({
  fetchRows = fetchIndexRows,
  cacheDir = path.join(process.cwd(), '.gev-cache'),
  now = () => Date.now(),
  ttlMs = ALPHA_EARTH_INDEX_TTL_MS,
} = {}) {
  const cachePath = path.join(cacheDir, 'alpha-earth-index.json');
  /** @type {?Map<number, Array<object>>} */
  let byYear = null;
  let loadedAt = null;
  let loading = null;

  function partition(records) {
    const years = new Map();
    for (const record of records) {
      if (!record) continue;
      if (!years.has(record.year)) years.set(record.year, []);
      years.get(record.year).push(record);
    }
    return years;
  }

  async function readDisk() {
    try {
      const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      if (
        parsed?.schema === DISK_SCHEMA &&
        Number.isFinite(parsed.at) &&
        now() - parsed.at < ttlMs &&
        Array.isArray(parsed.records)
      ) {
        return parsed;
      }
    } catch {
      /* no disk copy yet */
    }
    return null;
  }

  async function writeDisk(at, records) {
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(
        cachePath,
        JSON.stringify({ schema: DISK_SCHEMA, at, records }),
        'utf8',
      );
    } catch (err) {
      console.warn(
        '[alpha-earth] index cache write failed:',
        err?.message || err,
      );
    }
  }

  async function load() {
    const disk = await readDisk();
    if (disk) {
      byYear = partition(disk.records);
      loadedAt = disk.at;
      return;
    }
    const records = (await fetchRows()).map(normalizeIndexRow).filter(Boolean);
    if (!records.length) throw new Error('AlphaEarth index is empty');
    loadedAt = now();
    byYear = partition(records);
    await writeDisk(loadedAt, records);
  }

  function ready() {
    if (byYear) return Promise.resolve();
    if (!loading) {
      loading = load().finally(() => {
        loading = null;
      });
    }
    return loading;
  }

  return {
    ready,
    async years() {
      await ready();
      return [...byYear.keys()].sort((a, b) => a - b);
    },
    /** COGs of one year whose WGS84 footprint intersects the box. */
    async find(year, box) {
      await ready();
      const records = byYear.get(year) || [];
      return records.filter(
        (r) =>
          r.west < box.east &&
          r.east > box.west &&
          r.southLat < box.north &&
          r.northLat > box.south,
      );
    },
    status() {
      return {
        loaded: Boolean(byYear),
        loadedAt,
        years: byYear ? [...byYear.keys()].sort((a, b) => a - b) : [],
      };
    },
  };
}
