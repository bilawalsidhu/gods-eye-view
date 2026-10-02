#!/usr/bin/env node
/**
 * Build the bundled US places pack read by `src/data/placeBoundaries.js`:
 *
 *   src/data/local_data/us_census_places/index.json   state list, boxes, meta
 *   src/data/local_data/us_census_places/<ST>.json    one file per state
 *   src/data/local_data/us_census_places/files.js     their URLs, for bundlers
 *
 * Source: US Census Bureau 2025 cartographic boundary places
 * (cb_2025_us_place_500k, public domain), pinned by URL and SHA-256, so a
 * rerun reproduces the pack byte for byte. The download is cached outside the
 * repository (default: the system temp directory).
 *
 * Geometry uses the county pack's simplification and encoding
 * (scripts/build-admin-packs.mjs) with two differences: triangles are kept,
 * and a unit whose simplified rings cross themselves or each other is
 * simplified again at half the tolerance (finer precision last). Then
 * `scripts/pack_geometry.py repair census` checks every feature as a whole
 * MultiPolygon under GEOS and repairs the ones that are still invalid (rings
 * touching themselves, overlapping parts), so it needs Python with
 * shapely==2.1.2 on GEOS 3.13.1.
 *
 * Usage:
 *   node scripts/build-census-places.mjs [--cache <dir>] [--python <exe>]
 */

import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PARAMS as ADMIN_PARAMS,
  encodeUnit,
  fetchPinned,
  readDbf,
  readShp,
  shpPolygons,
  simplifyPolygons,
  unitTolerance,
  unzip,
} from './build-admin-packs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/data/local_data/us_census_places');

export const SOURCE = Object.freeze({
  url: 'https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_place_500k.zip',
  sha256: 'ce0e4019ecd4123d03d53aaa936eed0459b82e3e14b89a3dcd4d5e8b3308627d',
});

/** County-pack parameters; triangles are valid rings here. */
export const PARAMS = Object.freeze({
  ...ADMIN_PARAMS.counties,
  minRingVertices: 3,
  maxRepairSteps: 8,
});

/** Census LSAD codes for census designated places (unincorporated). */
const CDP_LSAD = new Set(['55', '57', '62']);

// ── validity ─────────────────────────────────────────────────────────────

function orient(ax, ay, bx, by, cx, cy) {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function onSegment(ax, ay, bx, by, px, py) {
  return (
    Math.min(ax, bx) <= px &&
    px <= Math.max(ax, bx) &&
    Math.min(ay, by) <= py &&
    py <= Math.max(ay, by)
  );
}

/** Whether segments ab and cd share any point (touching counts). */
export function segmentsIntersect(a, b, c, d) {
  const o1 = orient(a[0], a[1], b[0], b[1], c[0], c[1]);
  const o2 = orient(a[0], a[1], b[0], b[1], d[0], d[1]);
  const o3 = orient(c[0], c[1], d[0], d[1], a[0], a[1]);
  const o4 = orient(c[0], c[1], d[0], d[1], b[0], b[1]);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a[0], a[1], b[0], b[1], c[0], c[1])) return true;
  if (o2 === 0 && onSegment(a[0], a[1], b[0], b[1], d[0], d[1])) return true;
  if (o3 === 0 && onSegment(c[0], c[1], d[0], d[1], a[0], a[1])) return true;
  if (o4 === 0 && onSegment(c[0], c[1], d[0], d[1], b[0], b[1])) return true;
  return false;
}

/**
 * Whether segments of two different rings cross or overlap. Rings may touch
 * at a point (a hole meeting its outer ring at a vertex is valid).
 */
function segmentsCross(s, t) {
  const [a, b, c, d] = [s.a, s.b, t.a, t.b];
  const o1 = orient(a[0], a[1], b[0], b[1], c[0], c[1]);
  const o2 = orient(a[0], a[1], b[0], b[1], d[0], d[1]);
  const o3 = orient(c[0], c[1], d[0], d[1], a[0], a[1]);
  const o4 = orient(c[0], c[1], d[0], d[1], b[0], b[1]);
  if (o1 && o2 && o3 && o4) return o1 !== o2 && o3 !== o4;
  if (o1 === 0 && o2 === 0) {
    // Collinear: overlapping by more than a point.
    const key = a[0] !== b[0] ? 0 : 1;
    const lo = Math.max(Math.min(a[key], b[key]), Math.min(c[key], d[key]));
    const hi = Math.min(Math.max(a[key], b[key]), Math.max(c[key], d[key]));
    return hi > lo;
  }
  // One endpoint on the other segment: a crossing only when the rings pass
  // through each other there; a touch at a point is allowed.
  return false;
}

/**
 * Whether the rings of one part ([outer, ...holes], open, integer
 * coordinates) are simple: no ring crosses or touches itself away from its
 * shared vertices, no two rings cross or overlap (they may touch at a point),
 * and no ring is flat.
 */
export function partIsValid(rings) {
  const segments = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    if (ring.length < 3) return false;
    let twice = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
      twice += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    if (twice === 0) return false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      segments.push({
        r,
        i,
        n: ring.length,
        a,
        b,
        minX: Math.min(a[0], b[0]),
        maxX: Math.max(a[0], b[0]),
      });
    }
  }
  segments.sort((s, t) => s.minX - t.minX);
  for (let x = 0; x < segments.length; x++) {
    const s = segments[x];
    for (let y = x + 1; y < segments.length; y++) {
      const t = segments[y];
      if (t.minX > s.maxX) break;
      if (s.r === t.r) {
        const gap = Math.abs(s.i - t.i);
        // Neighbours share exactly one vertex; that is not a crossing — unless
        // they fold back over each other.
        if (gap === 1 || gap === s.n - 1) {
          if (s.n > 3 && collinearOverlap(s, t)) return false;
          continue;
        }
      }
      if (segmentsCross(s, t)) return false;
    }
  }
  return true;
}

function collinearOverlap(s, t) {
  const shared =
    s.a === t.a || s.a === t.b ? s.a : s.b === t.a || s.b === t.b ? s.b : null;
  if (!shared) return false;
  const p = s.a === shared ? s.b : s.a;
  const q = t.a === shared ? t.b : t.a;
  if (orient(shared[0], shared[1], p[0], p[1], q[0], q[1]) !== 0) return false;
  // Collinear and pointing the same way from the shared vertex: a spike.
  return (
    (p[0] - shared[0]) * (q[0] - shared[0]) +
      (p[1] - shared[1]) * (q[1] - shared[1]) >
    0
  );
}

function toIntegers(polygons, decimals) {
  const f = 10 ** decimals;
  return polygons.map((poly) =>
    poly.map((ring) =>
      ring.map(([lon, lat]) => [Math.round(lon * f), Math.round(lat * f)]),
    ),
  );
}

export function polygonsValid(polygons, decimals) {
  return toIntegers(polygons, decimals).every(partIsValid);
}

/**
 * Simplify a place like `simplifyUnit`, then halve the tolerance until every
 * part is valid; then one more decimal; then the source rings at two more.
 * @returns {{polygons: Array, decimals: number, repaired: boolean, valid: boolean}}
 */
export function simplifyPlace(source, params = PARAMS) {
  let tolerance = unitTolerance(source, params);
  const attempts = [];
  for (let step = 0; step <= params.maxRepairSteps; step++) {
    attempts.push([tolerance, params.decimals]);
    tolerance /= 2;
  }
  attempts.push([params.minToleranceDeg / 5, params.decimals + 1]);
  attempts.push([0, params.decimals + 1]);
  attempts.push([0, params.decimals + 2]);
  let first = null;
  for (let i = 0; i < attempts.length; i++) {
    const [tol, decimals] = attempts[i];
    const polygons = simplifyPolygons(source, params, tol, decimals);
    if (!polygons.length) continue;
    first ||= { polygons, decimals };
    if (polygonsValid(polygons, decimals))
      return { polygons, decimals, repaired: i > 0, valid: true };
  }
  return first
    ? { ...first, repaired: false, valid: false }
    : {
        polygons: [],
        decimals: params.decimals,
        repaired: false,
        valid: false,
      };
}

// ── names ────────────────────────────────────────────────────────────────

const GOVERNMENT =
  /\s+(?:metropolitan government|unified government|consolidated government|metro government|city and county|urban county)\b.*$/i;

/**
 * Everyday names for records whose Census name is formal: "Nashville-Davidson
 * metropolitan government (balance)" is also "Nashville"; "Urban Honolulu"
 * is "Honolulu".
 */
export function placeAliases(name) {
  const out = new Set();
  let base = String(name).replace(/\s*\(balance\)\s*$/i, '');
  if (base !== name) out.add(base);
  const stripped = base.replace(GOVERNMENT, '');
  if (stripped !== base) {
    out.add(stripped);
    base = stripped;
  }
  if (base !== name && /[-/]/.test(base)) out.add(base.split(/[-/]/)[0].trim());
  const urban = /^Urban (.+)$/.exec(name);
  if (urban) out.add(urban[1]);
  out.delete(name);
  return [...out].filter(Boolean).sort();
}

// ── pack ─────────────────────────────────────────────────────────────────

function bboxOf(polygons) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const poly of polygons)
    for (const [lon, lat] of poly[0]) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  return [w, s, e, n];
}

function union(boxes) {
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

/**
 * The box of a state's places. Alaska crosses the antimeridian: its box is
 * taken with western longitudes shifted past 180 when that is narrower.
 */
function unionBox(boxes) {
  const plain = union(boxes);
  const shifted = union(
    boxes.map(([w, s, e, n]) =>
      e < 0 ? [w + 360, s, e + 360, n] : [w, s, e, n],
    ),
  );
  return shifted[2] - shifted[0] < plain[2] - plain[0] ? shifted : plain;
}

async function build() {
  const params = PARAMS;
  const source = await fetchPinned('places', SOURCE);
  const files = unzip(source.bytes);
  const base = path.basename(new URL(SOURCE.url).pathname, '.zip');
  const shapes = readShp(files.get(`${base}.shp`));
  const records = readDbf(files.get(`${base}.dbf`));
  if (shapes.length !== records.length)
    throw new Error('places: shp/dbf record counts differ');
  const states = new Map();
  const stats = { records: records.length, repaired: [], invalid: [] };
  records.forEach((record, index) => {
    const unit = simplifyPlace(shpPolygons(shapes[index]), params);
    if (!unit.polygons.length) throw new Error(`no geometry: ${record.GEOID}`);
    if (unit.repaired) stats.repaired.push(record.GEOID);
    if (!unit.valid) stats.invalid.push(record.GEOID);
    const alt = placeAliases(record.NAME);
    const lsad = record.NAMELSAD.startsWith(record.NAME)
      ? record.NAMELSAD.slice(record.NAME.length).trim()
      : '';
    let state = states.get(record.STUSPS);
    if (!state) {
      state = {
        st: record.STUSPS,
        fips: record.STATEFP,
        name: record.STATE_NAME,
        features: [],
        boxes: [],
      };
      states.set(record.STUSPS, state);
    }
    state.boxes.push(bboxOf(unit.polygons));
    state.features.push({
      geoid: record.GEOID,
      name: record.NAME,
      ...(alt.length ? { alt } : {}),
      full: record.NAMELSAD,
      ...(lsad ? { lsad } : {}),
      ...(CDP_LSAD.has(record.LSAD) ? { cdp: true } : {}),
      ...(unit.decimals !== params.decimals ? { d: unit.decimals } : {}),
      polygons: encodeUnit(unit),
    });
  });
  if (stats.invalid.length)
    throw new Error(`places still invalid: ${stats.invalid.join(', ')}`);

  await mkdir(OUT, { recursive: true });
  for (const file of await readdir(OUT))
    if (/^[A-Z]{2}\.json$/.test(file)) await rm(path.join(OUT, file));
  const list = [...states.values()].sort((a, b) => a.st.localeCompare(b.st));
  let bytes = 0;
  for (const state of list) {
    state.features.sort((a, b) => a.geoid.localeCompare(b.geoid));
    const text =
      JSON.stringify({
        st: state.st,
        state: state.name,
        fips: state.fips,
        features: state.features,
      }) + '\n';
    bytes += Buffer.byteLength(text);
    await writeFile(path.join(OUT, `${state.st}.json`), text);
  }
  const round = (v) => Math.round(v * 1e4) / 1e4;
  const index = {
    meta: {
      title: 'US Census Bureau cartographic boundary places',
      source: base,
      url: SOURCE.url,
      sha256: source.digest,
      license: 'Public domain (U.S. Government work, 17 U.S.C. § 105)',
      schema:
        'states[]: st (USPS), fips, name, count, bbox [w, s, e, n] (e > 180 across the antimeridian). <st>.json: st, state, fips, features[]: geoid, name (NAME), alt?[] (everyday names for formal records), full (NAMELSAD), lsad? (city, town, CDP, …), cdp? (census designated place), d? (decimals when not meta.decimals), polygons[][ring] (first ring outer, rest holes; each ring open and encoded as integers in 10^-d degrees, first vertex absolute then [dLon, dLat] deltas)',
      decimals: params.decimals,
      curation: params,
      script: 'scripts/build-census-places.mjs',
    },
    states: list.map((s) => ({
      st: s.st,
      fips: s.fips,
      name: s.name,
      count: s.features.length,
      bbox: unionBox(s.boxes).map(round),
    })),
  };
  await writeFile(
    path.join(OUT, 'index.json'),
    JSON.stringify(index, null, 1) + '\n',
  );
  await writeFile(path.join(OUT, 'files.js'), filesModule(list));
  const count = list.reduce((n, s) => n + s.features.length, 0);
  console.log(
    `us_census_places: ${count} places in ${list.length} files, ${bytes} bytes; ` +
      `${stats.repaired.length} re-simplified to stay valid`,
  );
  const args = process.argv.slice(2);
  const python = args.includes('--python')
    ? args[args.indexOf('--python') + 1]
    : 'python3';
  execFileSync(
    python,
    [path.join(ROOT, 'scripts/pack_geometry.py'), 'repair', 'census'],
    { stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  );
}

/**
 * The file list as literal URLs, so a bundler emits every state file as an
 * asset and the loader can fetch one by its code.
 */
function filesModule(list) {
  const lines = [
    '// Generated by scripts/build-census-places.mjs; do not edit.',
    "export const INDEX_URL = new URL('./index.json', import.meta.url);",
    'export const STATE_URLS = {',
    ...list.map(
      (s) => `  ${s.st}: new URL('./${s.st}.json', import.meta.url),`,
    ),
    '};',
  ];
  return lines.join('\n') + '\n';
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await build();
