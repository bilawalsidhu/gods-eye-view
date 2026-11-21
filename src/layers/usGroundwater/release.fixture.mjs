/** An invented Rainfolk-shaped release held in memory; no downloaded data. */
import { RAINFOLK_WELL_DATA_ORIGIN } from './source.js';

const bytes = (text) => new TextEncoder().encode(text);
const sha256 = async (text) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(text))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
const quantity = (unit, value) =>
  value === undefined
    ? { value: null, quality: 'missing', issue: null, unit }
    : { value, quality: 'valid', issue: null, unit };

/** One published-format record. Only the fields the app reads are filled in. */
export function publishedRecord(
  n,
  { lon = -97.74, lat = 30.27, depthFt, capacityGpm, constructed } = {},
) {
  return {
    id: `USGWD-${'a'.repeat(64)}-SYN_${n}`,
    longitude: lon,
    latitude: lat,
    metadata: {
      sourceRecordId: `SYN_${n}`,
      sourceState: 'Texas',
      quantities: {
        'Well Depth (Feet)': quantity('ft', depthFt),
        'Well Capacity (GPM)': quantity('gal/min', capacityGpm),
        'Screen Depth (Feet)': quantity('ft'),
        'Length of Screen (Feet)': quantity('ft'),
      },
      sourceYears: {
        'Year Well was Constructed': constructed
          ? { precision: 'year', year: String(constructed) }
          : null,
        'Year Reported': null,
      },
    },
  };
}

/**
 * Build a release from `states`: [{ name, bounds, tiles: [{ bounds, records,
 * count? }] }]. Returns the root hash that names it, and a fetch that serves it.
 */
export async function publishRelease(states, { indexedRecords } = {}) {
  const files = new Map();
  const children = [];
  for (const state of states) {
    const directory = `states/${state.name}/`;
    const regions = [];
    for (const tile of state.tiles) {
      const body = JSON.stringify({ records: tile.records });
      const hash = await sha256(body);
      files.set(`${directory}${hash}.json`, body);
      regions.push({
        bounds: tile.bounds,
        bytes: bytes(body).length,
        count: tile.count ?? tile.records.length,
        sha256: hash,
        url: `${hash}.json`,
      });
    }
    const body = JSON.stringify({ kind: 'gev-well-spatial-index', regions });
    const hash = await sha256(body);
    const url = `${directory}${hash}.index.json`;
    files.set(url, body);
    children.push({
      bounds: state.bounds,
      bytes: bytes(body).length,
      directory,
      sha256: hash,
      state: state.name,
      url,
    });
  }
  const root = JSON.stringify({
    kind: 'gev-well-spatial-index',
    indexedRecords:
      indexedRecords ??
      states.reduce(
        (n, s) => n + s.tiles.reduce((m, t) => m + t.records.length, 0),
        0,
      ),
    children,
  });
  const release = await sha256(root);
  files.set('index.json', root);
  const base = `${RAINFOLK_WELL_DATA_ORIGIN}/usgwd/${release}/`;
  const requests = [];
  return {
    release,
    files,
    requests,
    /** Path of the nth tile of the nth state, to tamper with or count. */
    tilePath: (state = 0, tile = 0) =>
      [...files.keys()].filter(
        (path) =>
          path.startsWith(`states/${states[state].name}/`) &&
          !path.endsWith('.index.json'),
      )[tile],
    async fetchImpl(url, options) {
      requests.push({ url, options });
      const body = url.startsWith(base)
        ? files.get(url.slice(base.length))
        : undefined;
      return body === undefined
        ? new Response('missing', { status: 404 })
        : new Response(body);
    },
  };
}
