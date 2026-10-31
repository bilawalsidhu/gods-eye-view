/**
 * Loader and schema validation for the bundled Sky view catalogues
 * (data/stars.json from HYG v4.4, data/constellations.json from Stellarium
 * "western"; both CC BY-SA, see NOTICE.md). Built by
 * scripts/build-sky-data.mjs; served same-origin as static assets, never
 * fetched from a third party.
 */

export const STARS_FORMAT = 'gev-sky-stars/1';
export const CONSTELLATIONS_FORMAT = 'gev-sky-constellations/1';
export const MIN_STARS = 8500;
export const CONSTELLATION_COUNT = 88;

export class SkyDataError extends Error {
  constructor(problems) {
    super(`sky data invalid: ${problems.slice(0, 5).join('; ')}`);
    this.name = 'SkyDataError';
    this.problems = problems;
  }
}

const COLUMNS = ['ra', 'dec', 'mag', 'bv', 'pmRa', 'pmDec', 'hip'];

/**
 * Validate the two raw JSON objects and turn them into typed arrays plus
 * index-resolved constellation lines. Throws SkyDataError listing problems.
 * @returns {{stars: object, hipIndex: Map<number, number>, constellations: object[]}}
 */
export function parseSkyData(starsJson, constellationsJson) {
  const problems = [];
  const fail = (message) => problems.push(message);

  if (starsJson?.format !== STARS_FORMAT)
    fail(`stars format ${starsJson?.format} != ${STARS_FORMAT}`);
  if (constellationsJson?.format !== CONSTELLATIONS_FORMAT)
    fail(
      `constellations format ${constellationsJson?.format} != ${CONSTELLATIONS_FORMAT}`,
    );
  if (problems.length) throw new SkyDataError(problems);

  const count = starsJson.count;
  if (!Number.isInteger(count) || count < MIN_STARS)
    fail(`star count ${count} < ${MIN_STARS}`);
  for (const name of COLUMNS)
    if (!Array.isArray(starsJson[name]) || starsJson[name].length !== count)
      fail(`column ${name} length != count ${count}`);
  if (problems.length) throw new SkyDataError(problems);

  const stars = {
    count,
    magLimit: starsJson.magLimit,
    ra: Float64Array.from(starsJson.ra),
    dec: Float64Array.from(starsJson.dec),
    mag: Float32Array.from(starsJson.mag),
    bv: Float32Array.from(starsJson.bv, (v) => (v === null ? NaN : v)),
    pmRa: Float32Array.from(starsJson.pmRa),
    pmDec: Float32Array.from(starsJson.pmDec),
    hip: Int32Array.from(starsJson.hip),
    names: new Map(),
    designations: new Map(),
  };
  const hipIndex = new Map();
  for (let i = 0; i < count; i++) {
    const [ra, dec, mag, hip] = [
      stars.ra[i],
      stars.dec[i],
      stars.mag[i],
      starsJson.hip[i],
    ];
    if (!(ra >= 0 && ra < 360)) fail(`star ${i} ra ${ra} out of range`);
    if (!(dec >= -90 && dec <= 90)) fail(`star ${i} dec ${dec} out of range`);
    if (!Number.isFinite(mag)) fail(`star ${i} mag not finite`);
    if (!Number.isFinite(stars.pmRa[i]) || !Number.isFinite(stars.pmDec[i]))
      fail(`star ${i} proper motion not finite`);
    if (!Number.isInteger(hip) || hip < 0) fail(`star ${i} hip ${hip} invalid`);
    else if (hip) {
      if (hipIndex.has(hip)) fail(`duplicate hip ${hip}`);
      hipIndex.set(hip, i);
    }
    if (problems.length > 20) throw new SkyDataError(problems);
  }
  for (const [key, target] of [
    ['names', stars.names],
    ['bf', stars.designations],
  ]) {
    for (const entry of starsJson[key] ?? []) {
      const [index, text] = Array.isArray(entry) ? entry : [];
      if (!Number.isInteger(index) || index < 0 || index >= count || !text)
        fail(`${key} entry ${JSON.stringify(entry)} invalid`);
      else target.set(index, String(text));
    }
  }

  const list = constellationsJson.constellations;
  if (!Array.isArray(list) || list.length !== CONSTELLATION_COUNT)
    fail(`constellation count ${list?.length} != ${CONSTELLATION_COUNT}`);
  const seen = new Set();
  const constellations = (Array.isArray(list) ? list : []).map((entry) => {
    const iau = String(entry?.iau ?? '');
    if (!/^[A-Z][a-zA-Z]{2}$/.test(iau)) fail(`bad IAU abbreviation ${iau}`);
    if (seen.has(iau)) fail(`duplicate constellation ${iau}`);
    seen.add(iau);
    if (!entry?.name || !entry?.native) fail(`${iau} has no name`);
    const lines = (Array.isArray(entry?.lines) ? entry.lines : []).map(
      (chain) =>
        (Array.isArray(chain) ? chain : []).map((hip) => {
          const index = hipIndex.get(hip);
          if (index === undefined)
            fail(`${iau} line endpoint HIP ${hip} not in star data`);
          return index ?? -1;
        }),
    );
    if (!lines.length || lines.some((chain) => chain.length < 2))
      fail(`${iau} has an empty or one-star line`);
    return {
      iau,
      name: String(entry?.name ?? ''),
      native: String(entry?.native ?? ''),
      lines,
    };
  });
  if (problems.length) throw new SkyDataError(problems);
  return { stars, hipIndex, constellations };
}

let cached = null;

/**
 * Fetch both catalogues (same-origin static assets emitted by Vite) and
 * validate them. Memoised; a failure clears the memo so a retry can work.
 */
export function loadSkyData({ fetchImpl = globalThis.fetch } = {}) {
  if (cached) return cached;
  const starsUrl = new URL('./data/stars.json', import.meta.url);
  const constellationsUrl = new URL(
    './data/constellations.json',
    import.meta.url,
  );
  const getJson = async (url) => {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`sky data ${response.status} for ${url}`);
    return response.json();
  };
  cached = Promise.all([getJson(starsUrl), getJson(constellationsUrl)])
    .then(([stars, constellations]) => parseSkyData(stars, constellations))
    .catch((error) => {
      cached = null;
      throw error;
    });
  return cached;
}

/** Test hook: forget the memoised load. */
export function resetSkyDataCache() {
  cached = null;
  boundariesCached = null;
}

export const BOUNDARIES_FORMAT = 'gev-sky-boundaries/1';

/**
 * Validate data/boundaries.json (J2000 polylines, precessed from B1875 at
 * build time) into [{a, b, ra: Float32Array, dec: Float32Array}].
 */
export function parseBoundaries(json) {
  const problems = [];
  if (json?.format !== BOUNDARIES_FORMAT)
    problems.push(`boundaries format ${json?.format} != ${BOUNDARIES_FORMAT}`);
  const edges = Array.isArray(json?.edges) ? json.edges : [];
  if (!edges.length) problems.push('no boundary edges');
  const out = edges.map((edge, i) => {
    const flat = Array.isArray(edge?.points) ? edge.points : [];
    if (flat.length < 4 || flat.length % 2)
      problems.push(`edge ${i} has ${flat.length / 2} points`);
    const n = Math.floor(flat.length / 2);
    const ra = new Float32Array(n);
    const dec = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      ra[k] = flat[2 * k];
      dec[k] = flat[2 * k + 1];
      if (!(ra[k] >= 0 && ra[k] < 360) || !(dec[k] >= -90 && dec[k] <= 90))
        problems.push(`edge ${i} point ${k} out of range`);
    }
    return { a: String(edge?.a ?? ''), b: String(edge?.b ?? ''), ra, dec };
  });
  if (problems.length) throw new SkyDataError(problems);
  return out;
}

let boundariesCached = null;

/** Boundaries are optional (off by default), so they load only on demand. */
export function loadBoundaries({ fetchImpl = globalThis.fetch } = {}) {
  if (boundariesCached) return boundariesCached;
  const url = new URL('./data/boundaries.json', import.meta.url);
  boundariesCached = Promise.resolve()
    .then(() => fetchImpl(url))
    .then((response) => {
      if (!response.ok)
        throw new Error(`sky data ${response.status} for ${url}`);
      return response.json();
    })
    .then(parseBoundaries)
    .catch((error) => {
      boundariesCached = null;
      throw error;
    });
  return boundariesCached;
}
