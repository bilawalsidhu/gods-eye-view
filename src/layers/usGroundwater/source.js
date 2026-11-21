import { readResponseBytesCapped } from '../../sources/httpBody.js';

export const RAINFOLK_WELL_DATA_ORIGIN = 'https://data.rainfolk.org';
/** SHA-256 of the release's root index; every other file hangs off it. */
export const RAINFOLK_WELL_RELEASE =
  'e6dc61db1500b491671cf094602e2257814c5507e99618d717fbb4f6082d8291';

/** What one view may load. Past any of these the layer asks for a closer view. */
export const WELL_LIMITS = Object.freeze({
  records: 2000,
  tiles: 256,
  bytes: 16 * 1024 * 1024,
  states: 8,
  spanDegrees: 2,
});

const FILE_BYTES = 8 * 1024 * 1024;
const CACHE_BYTES = 16 * 1024 * 1024;
const TILE_RECORDS = 500;
const TIMEOUT_MS = 15000;
const HEX = /^[a-f0-9]{64}$/;

/** A file that does not match its hash, or whose structure cannot be used. */
export class WellIntegrityError extends Error {
  constructor(what) {
    super(`Invalid well ${what}`);
    this.name = 'WellIntegrityError';
  }
}
const invalid = (what) => {
  throw new WellIntegrityError(what);
};

const size = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const isBox = (b) =>
  Array.isArray(b) &&
  b.length === 4 &&
  b.every(Number.isFinite) &&
  b[0] >= -180 &&
  b[2] <= 180 &&
  b[1] >= -90 &&
  b[3] <= 90 &&
  b[0] < b[2] &&
  b[1] < b[3];
/** A view is [west, south, east, north]; west > east crosses the antimeridian. */
const isView = (v) =>
  Array.isArray(v) && v.length === 4 && v.every(Number.isFinite) && v[1] < v[3];
const viewWidth = (v) => (v[2] >= v[0] ? v[2] - v[0] : v[2] - v[0] + 360);
const inLongitude = (lon, v) =>
  v[0] <= v[2] ? lon >= v[0] && lon <= v[2] : lon >= v[0] || lon <= v[2];
const intersects = (box, v) =>
  box[1] < v[3] &&
  box[3] > v[1] &&
  (v[0] <= v[2]
    ? box[0] < v[2] && box[2] > v[0]
    : box[2] > v[0] || box[0] < v[2]);

function parseRoot(index) {
  if (
    index?.kind !== 'gev-well-spatial-index' ||
    !size(index.indexedRecords, 1e9) ||
    !Array.isArray(index.children) ||
    index.children.length > 64
  )
    invalid('index');
  return {
    total: index.indexedRecords,
    states: index.children.map((c) => {
      if (
        typeof c?.directory !== 'string' ||
        !/^states\/[A-Za-z_]+\/$/.test(c.directory) ||
        !HEX.test(c.sha256) ||
        c.url !== `${c.directory}${c.sha256}.index.json` ||
        !size(c.bytes, FILE_BYTES) ||
        !isBox(c.bounds)
      )
        invalid('state reference');
      return {
        path: c.url,
        directory: c.directory,
        sha256: c.sha256,
        bytes: c.bytes,
        bounds: c.bounds,
      };
    }),
  };
}

function parseState(index, directory) {
  if (
    index?.kind !== 'gev-well-spatial-index' ||
    !Array.isArray(index.regions) ||
    index.regions.length > 40000
  )
    invalid('state index');
  return index.regions.map((t) => {
    if (
      !HEX.test(t?.sha256) ||
      t.url !== `${t.sha256}.json` ||
      !size(t.bytes, FILE_BYTES) ||
      !size(t.count, TILE_RECORDS) ||
      !isBox(t.bounds)
    )
      invalid('tile reference');
    return {
      path: directory + t.url,
      sha256: t.sha256,
      bytes: t.bytes,
      count: t.count,
      bounds: t.bounds,
    };
  });
}

const QUANTITIES = [
  ['depthFt', 'Well Depth (Feet)', 'ft'],
  ['capacityGpm', 'Well Capacity (GPM)', 'gal/min'],
  ['screenDepthFt', 'Screen Depth (Feet)', 'ft'],
  ['screenLengthFt', 'Length of Screen (Feet)', 'ft'],
];
const YEARS = [
  ['constructedYear', 'Year Well was Constructed'],
  ['reportedYear', 'Year Reported'],
];

/**
 * Keep only what the map and the card use. A record that cannot be placed is
 * skipped, so one bad row never hides its neighbours.
 */
function parseTile(pack, tile) {
  if (!Array.isArray(pack?.records) || pack.records.length > TILE_RECORDS)
    invalid('tile');
  const records = [];
  for (const r of pack.records) {
    if (
      typeof r?.id !== 'string' ||
      !r.id ||
      r.id.length > 160 ||
      !Number.isFinite(r.longitude) ||
      !Number.isFinite(r.latitude) ||
      r.longitude < tile.bounds[0] ||
      r.longitude > tile.bounds[2] ||
      r.latitude < tile.bounds[1] ||
      r.latitude > tile.bounds[3]
    )
      continue;
    const m = r.metadata ?? {};
    const text = (value) =>
      typeof value === 'string' && value ? value.slice(0, 64) : null;
    const record = {
      id: r.id,
      recordId: text(m.sourceRecordId) ?? r.id,
      state: text(m.sourceState),
      longitude: r.longitude,
      latitude: r.latitude,
    };
    for (const [key, field, unit] of QUANTITIES) {
      const q = m.quantities?.[field];
      record[key] =
        q?.quality === 'valid' &&
        q.unit === unit &&
        Number.isFinite(q.value) &&
        q.value >= 0
          ? q.value
          : null;
    }
    for (const [key, field] of YEARS) {
      const y = m.sourceYears?.[field];
      record[key] =
        y?.precision === 'year' && /^[0-9]{4}$/.test(y.year) ? y.year : null;
    }
    records.push(record);
  }
  return records;
}

/** Run `task` over `items`, four at a time, keeping their order. */
async function mapLimit(items, task) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (!failed && next < items.length) {
        const i = next++;
        try {
          results[i] = await task(items[i]);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return results;
}

/**
 * Rainfolk's published USGWD release. Files are named by their SHA-256 and
 * checked against it, starting from the pinned root, so a release never
 * changes under the app; a new release is a new hash and a rebuild.
 */
export function createRainfolkWellSource({
  release = RAINFOLK_WELL_RELEASE,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof release !== 'string' || !HEX.test(release))
    throw new TypeError('Invalid Rainfolk well release');
  const base = `${RAINFOLK_WELL_DATA_ORIGIN}/usgwd/${release}/`;
  // Parsed, checked files by hash, least recently used first. They cannot
  // change, so nothing is ever re-read or re-checked.
  const cache = new Map();
  let cachedBytes = 0;
  let root;

  async function read(path, sha256, cap, parse, signal) {
    const hit = cache.get(sha256);
    if (hit) {
      cache.delete(sha256);
      cache.set(sha256, hit);
      return hit.value;
    }
    const response = await fetchImpl(base + path, {
      signal,
      credentials: 'omit',
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(`Well data unavailable (HTTP ${response.status})`);
    const bytes = await readResponseBytesCapped(response, cap, signal);
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    if (digest !== sha256) invalid('file hash');
    let json;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      invalid('file');
    }
    const value = parse(json);
    cache.set(sha256, { value, bytes: bytes.length });
    cachedBytes += bytes.length;
    while (cachedBytes > CACHE_BYTES && cache.size > 1) {
      const [oldest, entry] = cache.entries().next().value;
      cache.delete(oldest);
      cachedBytes -= entry.bytes;
    }
    return value;
  }

  return {
    /**
     * Records inside `bounds`, or `limited: true` with none when the view is
     * too wide or holds too many. `total` is every record in the release.
     */
    async getSnapshot({ signal, bounds } = {}) {
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      root ??= await read(
        'index.json',
        release,
        FILE_BYTES,
        parseRoot,
        combined,
      );
      const { total, states } = root;
      const limited = { records: [], total, limited: true };
      if (
        !isView(bounds) ||
        viewWidth(bounds) > WELL_LIMITS.spanDegrees ||
        bounds[3] - bounds[1] > WELL_LIMITS.spanDegrees
      )
        return limited;
      const inView = states.filter((s) => intersects(s.bounds, bounds));
      if (inView.length > WELL_LIMITS.states) return limited;
      const regions = await mapLimit(inView, (s) =>
        read(
          s.path,
          s.sha256,
          s.bytes,
          (json) => parseState(json, s.directory),
          combined,
        ),
      );
      const tiles = regions.flat().filter((t) => intersects(t.bounds, bounds));
      if (
        tiles.length > WELL_LIMITS.tiles ||
        tiles.reduce((n, t) => n + t.count, 0) > WELL_LIMITS.records ||
        tiles.reduce((n, t) => n + t.bytes, 0) > WELL_LIMITS.bytes
      )
        return limited;
      const packs = await mapLimit(tiles, (t) =>
        read(t.path, t.sha256, t.bytes, (json) => parseTile(json, t), combined),
      );
      const records = new Map();
      for (const record of packs.flat())
        if (
          record.latitude >= bounds[1] &&
          record.latitude <= bounds[3] &&
          inLongitude(record.longitude, bounds)
        )
          records.set(record.id, record);
      return { records: [...records.values()], total, limited: false };
    },
  };
}
