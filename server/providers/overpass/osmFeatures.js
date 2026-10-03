import { OSM_PRESETS } from '../../../src/data/osmPresets.js';

/**
 * Bounded, typed OpenStreetMap feature search: one preset from the curated
 * table inside a bounding box.
 *
 * The request carries a preset id, a box, a mode and a limit — never query
 * text. The server writes the Overpass query itself and bounds it: box size
 * per mode (a count may cover more ground than a fetch), result count,
 * Overpass timeout and memory, response bytes, and one query in flight. It
 * runs only against the operator's `OVERPASS_UPSTREAMS`; the generic
 * `/api/overpass` guard is untouched.
 *
 * There is deliberately no boundary (`area`) filter: Overpass servers differ
 * in whether they hold area data, and one without it answers zero rather than
 * failing. The browser filters the box's features by the exact area geometry
 * instead, so a count inside a province is exact and a box count is labelled
 * as a box count.
 */
export const OSM_FEATURE_LIMITS = Object.freeze({
  /** Largest box a fetch may cover, in square degrees (~200 × 200 km at the equator). */
  maxFetchDeg2: 4,
  /** Largest box a count may cover. */
  maxCountDeg2: 36,
  /** Most features one fetch returns. */
  maxLimit: 1000,
  /** Overpass server-side timeout, seconds. */
  timeoutS: 25,
  /** Overpass server-side memory cap, bytes. */
  maxsize: 64 * 1024 * 1024,
  /** Response bytes read from the upstream. */
  maxResponseBytes: 16 * 1024 * 1024,
  /** Per-upstream wait: a busy Overpass answers these in 10–30 s. */
  upstreamTimeoutMs: 40_000,
});

/** Tags a returned feature keeps, besides the preset's own. */
const KEPT_TAGS = [
  'name',
  'name:en',
  'operator',
  'brand',
  'opening_hours',
  'wheelchair',
  'emergency',
  'healthcare',
  'addr:street',
  'addr:city',
];

const quote = (text) =>
  `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Parse and bound a request. Returns the compiled query or a refusal.
 * @param {{preset: string, bbox: string|number[], mode?: string, limit?: string|number}} request
 * @returns {{ok: true, ql: string, mode: string, preset: object, limit: number, boxes: number[][]}|{ok: false, code: string, error: string}}
 */
export function compileOsmFeatureQuery(request = {}) {
  const refuse = (code, error) => ({ ok: false, code, error });
  const presetId = String(request.preset || '');
  const preset = Object.hasOwn(OSM_PRESETS, presetId)
    ? OSM_PRESETS[presetId]
    : null;
  if (!preset) return refuse('UNKNOWN_PRESET', 'Unknown feature kind.');
  const mode = request.mode === 'count' ? 'count' : 'features';
  const parts = (
    Array.isArray(request.bbox)
      ? request.bbox
      : String(request.bbox || '').split(',')
  ).map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite))
    return refuse('BAD_BOX', 'bbox needs west,south,east,north.');
  const [west, south, east, north] = parts;
  if (
    Math.abs(west) > 180 ||
    Math.abs(east) > 180 ||
    south < -90 ||
    north > 90 ||
    south >= north ||
    west === east
  )
    return refuse('BAD_BOX', 'bbox edges are out of range.');
  // A box crossing the antimeridian is searched as its two halves.
  const boxes =
    west < east
      ? [[south, west, north, east]]
      : [
          [south, west, north, 180],
          [south, -180, north, east],
        ];
  const deg2 = boxes.reduce((sum, [s, w, n, e]) => sum + (n - s) * (e - w), 0);
  const cap =
    mode === 'count'
      ? OSM_FEATURE_LIMITS.maxCountDeg2
      : OSM_FEATURE_LIMITS.maxFetchDeg2;
  if (deg2 > cap)
    return refuse(
      'AREA_TOO_LARGE',
      mode === 'count'
        ? 'That area is too large to search; narrow it down.'
        : 'That area is too large to list; count first or narrow it down.',
    );
  const requested = Number(request.limit);
  const limit = Math.max(
    1,
    Math.min(
      OSM_FEATURE_LIMITS.maxLimit,
      Number.isFinite(requested) ? Math.trunc(requested) : 500,
    ),
  );
  const selectors = [];
  for (const [key, value] of preset.tags)
    for (const [s, w, n, e] of boxes)
      selectors.push(
        `nwr[${quote(key)}=${quote(value)}](${s},${w},${n},${e});`,
      );
  const ql =
    `[out:json][timeout:${OSM_FEATURE_LIMITS.timeoutS}][maxsize:${OSM_FEATURE_LIMITS.maxsize}];` +
    `(${selectors.join('')});` +
    (mode === 'count' ? 'out count;' : `out center tags ${limit};`);
  return { ok: true, ql, mode, preset, limit, boxes };
}

/**
 * Overpass JSON → the compact answer the browser gets.
 * @param {object} payload Parsed Overpass JSON.
 * @param {{mode: string, preset: object, limit: number}} compiled
 */
export function summarizeOsmFeatures(payload, compiled) {
  if (!Array.isArray(payload?.elements))
    throw new TypeError('Malformed Overpass feature response');
  const elements = payload.elements;
  if (compiled.mode === 'count') {
    const tags = elements.find((el) => el?.type === 'count')?.tags;
    const rawTotal = tags?.total;
    const total = Number(rawTotal);
    if (
      !tags ||
      !Object.hasOwn(tags, 'total') ||
      !['string', 'number'].includes(typeof rawTotal) ||
      String(rawTotal).trim() === '' ||
      !Number.isSafeInteger(total) ||
      total < 0
    )
      throw new TypeError('Malformed Overpass count response');
    return {
      mode: 'count',
      preset: compiled.preset.id,
      count: total,
      nodes: Number(tags.nodes) || 0,
      ways: Number(tags.ways) || 0,
      relations: Number(tags.relations) || 0,
    };
  }
  const features = [];
  let unplaced = 0;
  for (const el of elements) {
    if (
      !['node', 'way', 'relation'].includes(el?.type) ||
      (!Number.isFinite(Number(el?.id)) && typeof el?.id !== 'string')
    ) {
      unplaced += 1;
      continue;
    }
    const lat = Number.isFinite(el?.lat) ? el.lat : el?.center?.lat;
    const lon = Number.isFinite(el?.lon) ? el.lon : el?.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      unplaced += 1;
      continue;
    }
    const tags = {};
    for (const key of [...KEPT_TAGS, ...compiled.preset.tags.map(([k]) => k)])
      if (typeof el.tags?.[key] === 'string')
        tags[key] = el.tags[key].slice(0, 120);
    features.push({ id: `${el.type}/${el.id}`, lat, lon, tags });
  }
  // A genuinely empty `elements` array is authoritative. A non-empty answer
  // whose every row is unusable is a schema failure, not "zero places"; do
  // not let the route cache that as current state for a day.
  if (elements.length && features.length === 0)
    throw new TypeError('Overpass feature response has no usable rows');
  return {
    mode: 'features',
    preset: compiled.preset.id,
    count: features.length,
    features,
    truncated: elements.length >= compiled.limit,
    ...(unplaced ? { unplaced } : {}),
  };
}
