/**
 * NASA CMR granule catalog for the HLS products, folded with the VIIRS
 * overview days into one candidate list.
 */
import {
  CATALOG_DAYS,
  PRODUCTS,
  coverageFor,
  groupGranulesByDay,
  mergeCandidates,
  utcDay,
  validateBox,
  viirsCandidates,
} from './model.js';

const CMR_ENDPOINT = 'https://cmr.earthdata.nasa.gov/search';
const DAY_MS = 86_400_000;
const CMR_PAGE_SIZE = 200;
/**
 * Most records read per collection. A 1,000 km box can touch hundreds of HLS
 * tiles a day; past this cap the newest days (the sort order) are kept and
 * the result is `truncated`.
 */
const CMR_MAX_RECORDS = 2000;
const CMR_SEARCH_AFTER = 'CMR-Search-After';

/**
 * Read one product's granules across CMR pages, sending back each response's
 * `CMR-Search-After` cursor until a short page, a missing cursor or the
 * record cap ends the walk. `truncated` is measured against CMR's `hits`.
 * @param {{ product: string, url: string, fetchImpl: typeof fetch, signal?: AbortSignal, maxRecords?: number }} request
 * @returns {Promise<{ granules: Array<object>, truncated: boolean }>}
 */
export async function fetchCmrPages({
  product,
  url,
  fetchImpl,
  signal,
  maxRecords = CMR_MAX_RECORDS,
}) {
  const granules = [];
  let hits = 0;
  let cursor = null;
  for (;;) {
    const init = { signal };
    if (cursor) init.headers = { [CMR_SEARCH_AFTER]: cursor };
    const response = await fetchImpl(url, init);
    if (!response?.ok)
      throw new Error(`HTTP ${response?.status ?? 'error'} from CMR`);
    const page = parseCmrUmm(await response.json(), product);
    granules.push(...page.granules);
    hits = Math.max(hits, page.hits);
    cursor = response.headers?.get?.(CMR_SEARCH_AFTER) ?? null;
    if (
      !cursor ||
      page.granules.length < CMR_PAGE_SIZE ||
      granules.length >= maxRecords ||
      granules.length >= hits
    )
      break;
  }
  return { granules, truncated: hits > granules.length };
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isoOrNull(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function ringOf(points) {
  const ring = points
    .map(([lon, lat]) => [finiteOrNull(lon), finiteOrNull(lat)])
    .filter(([lon, lat]) => lon !== null && lat !== null);
  return ring.length >= 3 ? ring : null;
}

function footprintOf(geometry) {
  const polygon = geometry?.GPolygons?.[0]?.Boundary?.Points;
  if (Array.isArray(polygon)) {
    const ring = ringOf(polygon.map((p) => [p?.Longitude, p?.Latitude]));
    if (ring) return ring;
  }
  const r = geometry?.BoundingRectangles?.[0];
  if (!r) return null;
  const [w, s, e, n] = [
    r.WestBoundingCoordinate,
    r.SouthBoundingCoordinate,
    r.EastBoundingCoordinate,
    r.NorthBoundingCoordinate,
  ];
  const ring = ringOf([
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ]);
  return ring?.length === 4 ? ring : null;
}

/**
 * Parse a CMR `granules.umm_json` response. Every field is optional upstream;
 * granules without a parseable start time are dropped.
 * @param {object} json
 * @param {string} product `S30` | `L30`
 * @returns {{ granules: Array<object>, hits: number }}
 */
export function parseCmrUmm(json, product) {
  const granules = [];
  for (const item of Array.isArray(json?.items) ? json.items : []) {
    const umm = item?.umm || {};
    const meta = item?.meta || {};
    const range = umm.TemporalExtent?.RangeDateTime || {};
    const timeStart = isoOrNull(range.BeginningDateTime);
    if (!timeStart) continue;
    const cloud = Array.isArray(umm.AdditionalAttributes)
      ? umm.AdditionalAttributes.find((a) => a?.Name === 'CLOUD_COVERAGE')
          ?.Values?.[0]
      : null;
    granules.push({
      id: String(
        meta['concept-id'] || umm.GranuleUR || meta['native-id'] || '',
      ),
      product,
      timeStart,
      timeEnd: isoOrNull(range.EndingDateTime) || timeStart,
      cloud: finiteOrNull(cloud),
      footprint: footprintOf(
        umm.SpatialExtent?.HorizontalSpatialDomain?.Geometry,
      ),
    });
  }
  return { granules, hits: finiteOrNull(json?.hits) ?? granules.length };
}

/**
 * CMR granule search URL for one HLS product over a box and time window.
 * @param {{ product: string, box: object, startIso: string, endIso: string }} query
 * @returns {string}
 */
export function cmrSearchUrl({ product, box, startIso, endIso }) {
  const spec = PRODUCTS[product];
  if (!spec?.cmrCollection)
    throw new TypeError(`No CMR collection for product: ${product}`);
  const result = validateBox(box);
  if (!result.ok) throw new TypeError(result.message);
  const { west, south, east, north } = result.box;
  return (
    `${CMR_ENDPOINT}/granules.umm_json` +
    `?collection_concept_id=${spec.cmrCollection}` +
    `&bounding_box=${west},${south},${east},${north}` +
    `&temporal=${startIso},${endIso}` +
    `&sort_key=-start_date&page_size=${CMR_PAGE_SIZE}`
  );
}

/**
 * Search both HLS collections concurrently and fold the results with the
 * VIIRS overview days. One product failing still yields the other's days plus
 * an `errors` entry; an invalid box or clock throws a TypeError.
 * @param {{ box: object, days?: number, now?: Date, fetchImpl?: typeof fetch, signal?: AbortSignal }} request
 * @returns {Promise<{ candidates: Array<object>, truncated: boolean, errors: Array<{ product: string, message: string }> }>}
 */
export async function searchHls({
  box,
  days = CATALOG_DAYS,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const validated = validateBox(box);
  if (!validated.ok) throw new TypeError(validated.message);
  if (typeof fetchImpl !== 'function')
    throw new TypeError('A fetch implementation is required');
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('A valid clock is required');
  const endIso = new Date(nowMs).toISOString();
  const startIso = `${utcDay(new Date(nowMs - (days - 1) * DAY_MS))}T00:00:00Z`;
  const products = ['S30', 'L30'];
  const settled = await Promise.allSettled(
    products.map((product) =>
      fetchCmrPages({
        product,
        url: cmrSearchUrl({ product, box: validated.box, startIso, endIso }),
        fetchImpl,
        signal,
      }),
    ),
  );
  const granules = [];
  const errors = [];
  let truncated = false;
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      granules.push(...result.value.granules);
      truncated ||= result.value.truncated;
    } else {
      errors.push({
        product: products[index],
        message: String(result.reason?.message || result.reason),
      });
    }
  });
  const hls = groupGranulesByDay(granules).map((candidate) => ({
    ...candidate,
    coverage: coverageFor(candidate, validated.box),
  }));
  return {
    candidates: mergeCandidates([hls, viirsCandidates(endIso, days)]),
    truncated,
    errors,
  };
}
