#!/usr/bin/env node
/**
 * Build the bundled Sky view star and constellation data.
 *
 * Run by hand; the output is committed under src/skyView/data/ and the
 * app never fetches a third-party catalogue at runtime.
 *
 *   node scripts/build-sky-data.mjs --hyg hyg_v44.csv.gz --western index.json
 *   node scripts/build-sky-data.mjs --hyg ... --western ... --check
 *
 * Inputs (download once, the SHA-256 of each is pinned below):
 *   HYG v4.4   https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v44.csv.gz
 *              (CC BY-SA 4.0, David Nash / astronexus)
 *   Stellarium https://raw.githubusercontent.com/Stellarium/stellarium-skycultures/master/western/index.json
 *              (western sky culture, text and data CC BY-SA)
 *
 * Output (deterministic: same inputs -> byte-identical files):
 *   stars.json           HYG stars with mag <= 6.5 PLUS every HIP id used by a
 *                        constellation line, columnar arrays sorted by
 *                        magnitude then HYG id.
 *   constellations.json  88 western constellations: IAU abbreviation, names,
 *                        line chains as HIP ids (Stellarium "thin" style
 *                        markers dropped).
 *   boundaries.json      IAU constellation boundaries (western `edges`,
 *                        B1875) densified to <= 1 deg steps and precessed to
 *                        J2000 here, so the app never precesses from B1875.
 *   manifest.json        input and output SHA-256, counts, sizes.
 *
 * --check rebuilds in memory and fails if the committed files differ.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { julianCenturies, precessionMatrix } from '../src/skyView/skyMath.js';

export const MAG_LIMIT = 6.5;
export const HYG_SHA256 =
  '00b349893b9a53106dd488d8371e8d2fa586043e500bb3cdb8bff3931682197d';
export const WESTERN_SHA256 =
  'a861accd345249a185a5ecfc2a516f34291c0aa52f4bb8d8337ffc53e9cef6b9';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = path.join(ROOT, 'src/skyView/data');

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const round = (value, places) => {
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/** Parse RFC 4180 CSV (quoted fields, doubled quotes) into arrays of strings. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Constellation records from the Stellarium western index.json object. */
export function buildConstellations(western) {
  if (!Array.isArray(western?.constellations))
    throw new Error('western index.json: no constellations array');
  return western.constellations
    .map((entry) => ({
      iau: String(entry.iau),
      name: String(entry.common_name?.english ?? ''),
      native: String(entry.common_name?.native ?? ''),
      lines: entry.lines
        .map((chain) => chain.filter((hip) => Number.isInteger(hip)))
        .filter((chain) => chain.length >= 2),
    }))
    .sort((a, b) => (a.iau < b.iau ? -1 : a.iau > b.iau ? 1 : 0));
}

/**
 * Besselian epoch B1875.0 as a UTC ms instant (JD 2405889.258550475; the
 * 1875 boundary epoch of Delporte's IAU constellation boundaries).
 */
export const B1875_MS = (2405889.258550475 - 2440587.5) * 86_400_000;
/** Densify boundary edges so no step is longer than this (degrees of arc). */
export const BOUNDARY_STEP_DEG = 1;

const EDGE_RE =
  /^(\d+):(\d+) ([MP])[+-] (\d\d):(\d\d):(\d\d) ([+-])(\d\d):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d) ([+-])(\d\d):(\d\d):(\d\d) ([A-Z]{3}\d?) ([A-Z]{3}\d?)$/;

/**
 * Constellation boundaries from the western `edges` (pbarbier.com edges_18,
 * epoch B1875): each edge is a meridian (constant RA) or a parallel
 * (constant Dec) OF B1875, densified in B1875 (so a parallel keeps its true
 * curved shape after precession) and precessed B1875 -> J2000 with the
 * inverse of the IAU 2006 matrix (skyMath.precessionMatrix). Output: one
 * flat [ra, dec, ra, dec, ...] J2000 polyline per edge (degrees, 2 dp).
 */
export function buildBoundaries(western, precessionMatrix, toJ2000T) {
  const edges = western?.edges;
  if (!Array.isArray(edges) || !edges.length)
    throw new Error('western index.json: no edges array');
  if (western.edges_epoch && western.edges_epoch !== 'B1875')
    throw new Error(`edges epoch ${western.edges_epoch} != B1875`);
  const p = precessionMatrix(toJ2000T);
  const D = Math.PI / 180;
  const toJ2000 = (raDeg, decDeg) => {
    // p maps J2000 -> B1875 (T < 0); its transpose maps B1875 -> J2000.
    const v = [
      Math.cos(decDeg * D) * Math.cos(raDeg * D),
      Math.cos(decDeg * D) * Math.sin(raDeg * D),
      Math.sin(decDeg * D),
    ];
    const w = [0, 1, 2].map(
      (i) => p[0][i] * v[0] + p[1][i] * v[1] + p[2][i] * v[2],
    );
    const ra = round((((Math.atan2(w[1], w[0]) / D) % 360) + 360) % 360, 2);
    return [
      ra >= 360 ? 0 : ra,
      round(Math.atan2(w[2], Math.hypot(w[0], w[1])) / D, 2),
    ];
  };
  return edges.map((text) => {
    const m = EDGE_RE.exec(String(text));
    if (!m) throw new Error(`bad boundary edge: ${text}`);
    const hms = (h, mi, s) =>
      (Number(h) + Number(mi) / 60 + Number(s) / 3600) * 15;
    const dms = (sign, d, mi, s) =>
      (sign === '-' ? -1 : 1) *
      (Number(d) + Number(mi) / 60 + Number(s) / 3600);
    const ra1 = hms(m[4], m[5], m[6]);
    const dec1 = dms(m[7], m[8], m[9], m[10]);
    const ra2 = hms(m[11], m[12], m[13]);
    const dec2 = dms(m[14], m[15], m[16], m[17]);
    let dRa = ra2 - ra1;
    if (dRa > 180) dRa -= 360;
    if (dRa < -180) dRa += 360;
    const dDec = dec2 - dec1;
    const arc =
      m[3] === 'P'
        ? Math.abs(dRa) * Math.cos(dec1 * D)
        : Math.hypot(dRa * Math.cos(dec1 * D), dDec);
    const steps = Math.max(1, Math.ceil(arc / BOUNDARY_STEP_DEG - 1e-9));
    const flat = [];
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      flat.push(...toJ2000(ra1 + dRa * f, dec1 + dDec * f));
    }
    return { a: m[18], b: m[19], points: flat };
  });
}

/** Star columns from parsed HYG rows (header first), keeping line stars. */
export function buildStars(rows, lineHips, magLimit = MAG_LIMIT) {
  const [header, ...body] = rows;
  const col = Object.fromEntries(header.map((name, index) => [name, index]));
  for (const name of [
    'id',
    'hip',
    'proper',
    'mag',
    'ci',
    'pmra',
    'pmdec',
    'rarad',
    'decrad',
    'bf',
  ])
    if (!(name in col)) throw new Error(`HYG csv: missing column ${name}`);
  const picked = [];
  const seenHip = new Set();
  for (const r of body) {
    if (r.length < header.length) continue;
    const id = Number(r[col.id]);
    if (id === 0) continue; // Sol
    const hip = r[col.hip] ? Number(r[col.hip]) : 0;
    const mag = Number(r[col.mag]);
    if (!Number.isFinite(mag)) continue;
    if (mag > magLimit && !lineHips.has(hip)) continue;
    if (hip) seenHip.add(hip);
    picked.push({ id, hip, mag, r });
  }
  const missing = [...lineHips].filter((hip) => !seenHip.has(hip));
  if (missing.length)
    throw new Error(`HYG has no row for line HIP ids: ${missing.join(',')}`);
  picked.sort((a, b) => a.mag - b.mag || a.id - b.id);
  const out = {
    ra: [],
    dec: [],
    mag: [],
    bv: [],
    pmRa: [],
    pmDec: [],
    hip: [],
    names: [],
    bf: [],
  };
  const RAD = 180 / Math.PI;
  picked.forEach(({ hip, mag, r }, index) => {
    const ra = Number(r[col.rarad]) * RAD;
    out.ra.push(round(((ra % 360) + 360) % 360, 4));
    out.dec.push(round(Number(r[col.decrad]) * RAD, 4));
    out.mag.push(round(mag, 2));
    const ci = r[col.ci] === '' ? null : Number(r[col.ci]);
    out.bv.push(Number.isFinite(ci) ? round(ci, 2) : null);
    out.pmRa.push(round(Number(r[col.pmra]) || 0, 1));
    out.pmDec.push(round(Number(r[col.pmdec]) || 0, 1));
    out.hip.push(hip);
    const proper = r[col.proper].trim();
    if (proper) out.names.push([index, proper]);
    const bf = r[col.bf].trim().replace(/\s+/g, ' ');
    if (bf) out.bf.push([index, bf]);
  });
  return out;
}

/** Build every output file body (strings) from the raw input buffers. */
export function buildSkyData(hygGz, westernJson) {
  const hygSha = sha256(hygGz);
  const westernSha = sha256(westernJson);
  const constellations = buildConstellations(
    JSON.parse(westernJson.toString('utf8')),
  );
  const lineHips = new Set(
    constellations.flatMap((c) => c.lines.flat()).filter(Boolean),
  );
  const rows = parseCsv(gunzipSync(hygGz).toString('utf8'));
  const columns = buildStars(rows, lineHips);
  const count = columns.ra.length;
  const stars = {
    format: 'gev-sky-stars/1',
    source:
      'HYG v4.4 (David Nash, astronexus), https://codeberg.org/astronexus/hyg',
    licence: 'CC BY-SA 4.0',
    epoch: 'J2000',
    units: {
      ra: 'deg ICRS/J2000',
      dec: 'deg ICRS/J2000',
      mag: 'V',
      bv: 'B-V colour index (null = unknown)',
      pmRa: 'mas/yr, mu_alpha* (includes cos dec)',
      pmDec: 'mas/yr',
      hip: 'Hipparcos id (0 = none)',
      names: '[index, IAU proper name]',
      bf: '[index, HYG Bayer/Flamsteed field]',
    },
    magLimit: MAG_LIMIT,
    count,
    ...columns,
  };
  const constellationFile = {
    format: 'gev-sky-constellations/1',
    source:
      'Stellarium sky cultures, western/index.json, https://github.com/Stellarium/stellarium-skycultures',
    licence: 'CC BY-SA (text and data, per western/description.md)',
    count: constellations.length,
    constellations,
  };
  const starsText = `${JSON.stringify(stars)}\n`;
  const constellationsText = `${JSON.stringify(constellationFile)}\n`;
  const western = JSON.parse(westernJson.toString('utf8'));
  const boundaryEdges = buildBoundaries(
    western,
    precessionMatrix,
    julianCenturies(B1875_MS),
  );
  const boundaryFile = {
    format: 'gev-sky-boundaries/1',
    source:
      'Stellarium sky cultures, western/index.json edges (pbarbier.com edges_18, IAU B1875), https://github.com/Stellarium/stellarium-skycultures',
    licence: 'CC BY-SA (text and data, per western/description.md)',
    epoch: 'J2000 (precessed from B1875 at build time, IAU 2006)',
    units: { points: 'flat [raDeg, decDeg, ...] J2000, 2 dp' },
    count: boundaryEdges.length,
    edges: boundaryEdges,
  };
  const boundariesText = `${JSON.stringify(boundaryFile)}\n`;
  const describe = (text) => {
    const buffer = Buffer.from(text, 'utf8');
    return {
      sha256: sha256(buffer),
      bytes: buffer.length,
      gzipBytes: gzipSync(buffer, { level: 9 }).length,
    };
  };
  const manifest = {
    format: 'gev-sky-manifest/1',
    generator: 'scripts/build-sky-data.mjs',
    inputs: {
      hyg: { file: 'hyg_v44.csv.gz', sha256: hygSha },
      western: { file: 'western/index.json', sha256: westernSha },
    },
    magLimit: MAG_LIMIT,
    counts: {
      stars: count,
      starsBrighterThanLimit: columns.mag.filter((m) => m <= MAG_LIMIT).length,
      lineStars: lineHips.size,
      constellations: constellations.length,
      lineSegments: constellations.reduce(
        (sum, c) =>
          sum + c.lines.reduce((acc, chain) => acc + chain.length - 1, 0),
        0,
      ),
      properNames: columns.names.length,
      boundaryEdges: boundaryEdges.length,
      boundaryPoints: boundaryEdges.reduce(
        (sum, edge) => sum + edge.points.length / 2,
        0,
      ),
    },
    outputs: {
      'stars.json': describe(starsText),
      'constellations.json': describe(constellationsText),
      'boundaries.json': describe(boundariesText),
    },
  };
  return {
    'stars.json': starsText,
    'constellations.json': constellationsText,
    'boundaries.json': boundariesText,
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

function main(argv) {
  const arg = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const hygPath = arg('--hyg');
  const westernPath = arg('--western');
  if (!hygPath || !westernPath) {
    console.error(
      'usage: build-sky-data.mjs --hyg hyg_v44.csv.gz --western index.json [--check] [--out dir]',
    );
    return 2;
  }
  const hyg = readFileSync(hygPath);
  const western = readFileSync(westernPath);
  for (const [label, buffer, expected] of [
    ['HYG', hyg, HYG_SHA256],
    ['western', western, WESTERN_SHA256],
  ]) {
    const actual = sha256(buffer);
    if (actual !== expected) {
      console.error(
        `${label} input SHA-256 ${actual} != pinned ${expected}; re-pin only after reviewing the upstream change`,
      );
      return 1;
    }
  }
  const files = buildSkyData(hyg, western);
  const outDir = arg('--out') ? path.resolve(arg('--out')) : OUT_DIR;
  if (argv.includes('--check')) {
    let bad = 0;
    for (const [name, text] of Object.entries(files)) {
      let current = '';
      try {
        current = readFileSync(path.join(outDir, name), 'utf8');
      } catch {
        /* missing */
      }
      if (current !== text) {
        console.error(`DIFFERS: ${name}`);
        bad += 1;
      }
    }
    console.log(bad ? `${bad} file(s) differ` : 'sky data up to date');
    return bad ? 1 : 0;
  }
  mkdirSync(outDir, { recursive: true });
  for (const [name, text] of Object.entries(files))
    writeFileSync(path.join(outDir, name), text);
  console.log(files['manifest.json']);
  return 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main(process.argv.slice(2));
