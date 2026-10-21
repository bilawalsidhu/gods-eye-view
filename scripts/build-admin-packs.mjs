#!/usr/bin/env node
/**
 * Build the bundled administrative-boundary packs read by
 * `src/data/adminBoundaries.js`:
 *
 *   src/data/local_data/natural_earth/states_provinces.json
 *     Natural Earth 10m admin-1 states and provinces (public domain).
 *   src/data/local_data/us_census_counties/counties.json
 *     US Census Bureau cartographic boundary counties (public domain).
 *
 * Both sources are pinned by URL and SHA-256, so a rerun reproduces the packs
 * byte for byte. Downloads are cached outside the repository (default: the
 * system temp directory) and are never committed.
 *
 * Usage:
 *   node scripts/build-admin-packs.mjs [--cache <dir>] [--only countries|admin1|counties]
 *
 * The provenance READMEs beside each pack record these parameters.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { normalizeAdminName } from '../src/data/adminBoundaries.js';
import {
  ringAreaKm2,
  signedArea,
  simplifyUnit,
  encodeUnit,
  geojsonPolygons,
  bboxOf,
} from './lib/admin-pack-geometry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NE_COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';
const NE_BASE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_COMMIT}/geojson`;

export const SOURCES = Object.freeze({
  countries: {
    url: `${NE_BASE}/ne_10m_admin_0_countries.geojson`,
    sha256: '239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255',
  },
  mapUnits: {
    url: `${NE_BASE}/ne_10m_admin_0_map_units.geojson`,
    sha256: '57da82be755f4afccd8f3b14251bb2752f5df1395f47d2d86f817470c4a48862',
  },
  admin1: {
    url: `${NE_BASE}/ne_10m_admin_1_states_provinces.geojson`,
    sha256: '22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5',
  },
  places: {
    url: `${NE_BASE}/ne_10m_populated_places_simple.geojson`,
    sha256: 'fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f',
  },
  counties: {
    url: 'https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_county_5m.zip',
    sha256: 'faec522080681e79be5be435c981009a77891206ff8a7f1d142f3bf5da9ebd74',
  },
});

/**
 * Pack parameters. The Douglas-Peucker tolerance scales with the unit's size
 * (`toleranceFactor` × √area, clamped to `[minToleranceDeg, maxToleranceDeg]`)
 * because a unit is viewed at a zoom that fits it: Texas keeps ~2 km detail,
 * Bavaria ~1 km, Travis County ~150 m. Parts smaller than `minPartKm2` or than
 * `minPartShare` of the largest part are dropped (the largest part always
 * stays); holes under `minHoleKm2` are dropped.
 */
export const PARAMS = Object.freeze({
  countries: {
    toleranceFactor: 0.004,
    minToleranceDeg: 0.005,
    maxToleranceDeg: 0.02,
    decimals: 3,
    minPartKm2: 20,
    minPartShare: 0.00003,
    minHoleKm2: 20,
  },
  admin1: {
    toleranceFactor: 0.004,
    minToleranceDeg: 0.005,
    maxToleranceDeg: 0.02,
    decimals: 3,
    minPartKm2: 20,
    minPartShare: 0.0003,
    minHoleKm2: 20,
  },
  counties: {
    toleranceFactor: 0.003,
    minToleranceDeg: 0.0005,
    maxToleranceDeg: 0.01,
    decimals: 4,
    minPartKm2: 1,
    minPartShare: 0.001,
    minHoleKm2: 1,
  },
  // A bare admin-1 name is marked ambiguous — the resolver then lets a
  // geocoder decide — when it is also a country, the name of a city of at
  // least `insideMinPopulation` inside the unit's box ("New York", "Madrid"),
  // or the name of a city of at least `elsewhereMinPopulation` outside it
  // ("Santa Fe", "Victoria"). A unit no larger than `cityStateMaxKm2` whose
  // own city lies inside is the city itself (Berlin, Vienna, Paris): it is
  // marked `cityState` and may be named alone however small.
  ambiguity: {
    insideMinPopulation: 200_000,
    elsewhereMinPopulation: 50_000,
    cityStateMaxKm2: 1_000,
  },
});

const args = process.argv.slice(2);
const cacheDir = path.resolve(
  args.includes('--cache')
    ? args[args.indexOf('--cache') + 1]
    : path.join(os.tmpdir(), 'gev-admin-packs'),
);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

async function fetchPinned(name) {
  const { url, sha256 } = SOURCES[name];
  const file = path.join(cacheDir, path.basename(new URL(url).pathname));
  let bytes = await readFile(file).catch(() => null);
  if (!bytes) {
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, bytes);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sha256)
    throw new Error(
      `${name}: SHA-256 ${digest} does not match the pinned ${sha256}`,
    );
  return { bytes, digest };
}

// ── zip / shapefile / dbf ───────────────────────────────────────────────

/** Read named entries from a zip archive (stored or deflated). */
function unzip(buffer) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('zip: bad central directory entry');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const dataStart =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(dataStart, dataStart + compressed);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`zip: unsupported method ${method} for ${name}`);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** Polygon records (shape type 5) as arrays of closed [lon, lat] rings. */
function readShp(buffer) {
  const shapes = [];
  let offset = 100;
  while (offset < buffer.length) {
    const length = buffer.readInt32BE(offset + 4) * 2;
    const content = offset + 8;
    const type = buffer.readInt32LE(content);
    const rings = [];
    if (type === 5) {
      const numParts = buffer.readInt32LE(content + 36);
      const numPoints = buffer.readInt32LE(content + 40);
      const partsAt = content + 44;
      const pointsAt = partsAt + numParts * 4;
      for (let p = 0; p < numParts; p++) {
        const start = buffer.readInt32LE(partsAt + p * 4);
        const end =
          p + 1 < numParts
            ? buffer.readInt32LE(partsAt + (p + 1) * 4)
            : numPoints;
        const ring = [];
        for (let i = start; i < end; i++)
          ring.push([
            buffer.readDoubleLE(pointsAt + i * 16),
            buffer.readDoubleLE(pointsAt + i * 16 + 8),
          ]);
        rings.push(ring);
      }
    } else if (type !== 0) {
      throw new Error(`shp: unsupported shape type ${type}`);
    }
    shapes.push(rings);
    offset = content + length;
  }
  return shapes;
}

/** dBASE records as plain objects (character and numeric fields). */
function readDbf(buffer) {
  const count = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const fields = [];
  for (let at = 32; buffer[at] !== 0x0d; at += 32) {
    fields.push({
      name: buffer.toString('latin1', at, at + 11).replace(/\0.*$/, ''),
      length: buffer[at + 16],
    });
  }
  const records = [];
  for (let r = 0; r < count; r++) {
    let at = headerLength + r * recordLength + 1;
    const record = {};
    for (const field of fields) {
      record[field.name] = buffer
        .toString('utf8', at, at + field.length)
        .trim();
      at += field.length;
    }
    records.push(record);
  }
  return records;
}

/** Group shapefile rings into polygons: clockwise outers, holes assigned by containment. */
function shpPolygons(rings) {
  const outers = [];
  const holes = [];
  for (const ring of rings) {
    if (ring.length < 4) continue;
    (signedArea(ring) < 0 ? outers : holes).push(ring);
  }
  const polygons = outers.map((outer) => [outer]);
  for (const hole of holes) {
    const [x, y] = hole[0];
    const owner = polygons.find(([outer]) => pointInRing(outer, x, y));
    if (owner) owner.push(hole);
    else polygons.push([hole.slice().reverse()]);
  }
  return polygons;
}

function pointInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

// ── packs ────────────────────────────────────────────────────────────────

const LATIN = /^[\p{Script=Latin}\p{N}\s.,'’()\-/&]+$/u;

function uniqueNames(values, exclude) {
  const seen = new Set(exclude.map(normalizeAdminName));
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    const key = normalizeAdminName(text);
    if (!text || !key || seen.has(key) || !LATIN.test(text)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

async function buildCountries() {
  const source = await fetchPinned('countries');
  const mapUnits = await fetchPinned('mapUnits');
  const params = PARAMS.countries;
  const features = [];
  for (const { properties: p, geometry } of JSON.parse(source.bytes).features) {
    const unit = simplifyUnit(geojsonPolygons(geometry), params);
    if (!unit.polygons.length) continue;
    const name = p.ADMIN || p.NAME_EN || p.NAME;
    features.push({
      name,
      alt: uniqueNames(
        [p.NAME, p.NAME_LONG, p.NAME_EN, p.FORMAL_EN, p.BRK_NAME].filter(
          Boolean,
        ),
        [name],
      ),
      country: name,
      iso: p.ADM0_A3,
      iso2: p.ISO_A2_EH || p.ISO_A2,
      type: 'Country',
      ...(unit.decimals !== params.decimals ? { d: unit.decimals } : {}),
      polygons: encodeUnit(unit),
    });
  }
  for (const { properties: p, geometry } of JSON.parse(mapUnits.bytes)
    .features) {
    if (p.ADM0_A3 !== 'GBR') continue;
    const unit = simplifyUnit(geojsonPolygons(geometry), params);
    features.push({
      name: p.GEOUNIT,
      country: p.ADMIN,
      iso: p.GU_A3,
      iso2: 'GB',
      type: 'Constituent country',
      ...(unit.decimals !== params.decimals ? { d: unit.decimals } : {}),
      polygons: encodeUnit(unit),
    });
  }
  features.sort((a, b) => a.name.localeCompare(b.name));
  return {
    meta: {
      title: 'Natural Earth admin-0 countries',
      mapUnits: SOURCES.mapUnits,
      source: 'ne_10m_admin_0_countries',
      url: SOURCES.countries.url,
      sha256: source.digest,
      commit: NE_COMMIT,
      license:
        'Public domain (https://www.naturalearthdata.com/about/terms-of-use/)',
      decimals: params.decimals,
      curation: params,
      script: 'scripts/build-admin-packs.mjs',
    },
    features,
  };
}

async function buildAdmin1() {
  const params = PARAMS.admin1;
  const source = await fetchPinned('admin1');
  const places = await fetchPinned('places');
  const collection = JSON.parse(source.bytes.toString('utf8'));
  const { ambiguity } = PARAMS;
  const cities = JSON.parse(places.bytes.toString('utf8'))
    .features.map((f) => f.properties)
    .filter((p) => p.pop_max >= ambiguity.elsewhereMinPopulation)
    .map((p) => ({
      keys: new Set([p.name, p.nameascii].map(normalizeAdminName)),
      lon: p.longitude,
      lat: p.latitude,
      population: p.pop_max,
      country: p.adm0name,
    }));
  const countryNames = new Set();
  for (const { properties: p } of collection.features)
    for (const name of [p.admin, p.geonunit])
      if (name) countryNames.add(normalizeAdminName(name));

  const features = [];
  for (const { properties: p, geometry } of collection.features) {
    const name = String(p.name || '').trim();
    if (!name) continue;
    const unit = simplifyUnit(geojsonPolygons(geometry), params);
    if (!unit.polygons.length) continue;
    const nameEn =
      p.name_en && normalizeAdminName(p.name_en) !== normalizeAdminName(name)
        ? String(p.name_en).trim()
        : null;
    const alt = uniqueNames(
      String(p.name_alt || '').split('|'),
      [name, nameEn].filter(Boolean),
    );
    const bbox = bboxOf(unit.polygons);
    const areaKm2 = unit.polygons.reduce(
      (sum, poly) => sum + ringAreaKm2(poly[0]),
      0,
    );
    const keys = new Set(
      [name, nameEn, ...alt].filter(Boolean).map(normalizeAdminName),
    );
    const amb = [];
    const ambAbroad = [];
    let cityState = false;
    const inBox = (c) =>
      c.lon >= bbox[0] &&
      c.lon <= bbox[2] &&
      c.lat >= bbox[1] &&
      c.lat <= bbox[3];
    for (const key of keys) {
      const namesakes = cities.filter((c) => c.keys.has(key));
      const ownCity = namesakes.some(
        (c) => inBox(c) && c.population >= ambiguity.insideMinPopulation,
      );
      const cityInside = ownCity && areaKm2 > ambiguity.cityStateMaxKm2;
      if (ownCity && !cityInside) cityState = true;
      const elsewhere = namesakes.filter((c) => !inBox(c));
      if (
        countryNames.has(key) ||
        cityInside ||
        elsewhere.some((c) => c.country === p.admin)
      )
        amb.push(key);
      // Only abroad: "Victoria, Australia" settles it; "Victoria" alone not.
      else if (elsewhere.length) ambAbroad.push(key);
    }
    const postal = String(p.postal || '').trim();
    features.push({
      name,
      ...(nameEn ? { nameEn } : {}),
      ...(alt.length ? { alt } : {}),
      ...(/^[A-Z]{2}$/.test(postal) ? { postal } : {}),
      type: p.type_en || p.type || null,
      ...(Number.isFinite(p.min_label) ? { rank: p.min_label } : {}),
      country: p.admin,
      iso2: p.iso_a2 && p.iso_a2 !== '-99' ? p.iso_a2 : null,
      iso: p.iso_3166_2 && !p.iso_3166_2.includes('~') ? p.iso_3166_2 : null,
      ...(amb.length ? { amb: amb.sort() } : {}),
      ...(ambAbroad.length ? { ambAbroad: ambAbroad.sort() } : {}),
      ...(cityState ? { cityState } : {}),
      ...(Number.isFinite(p.longitude) && Number.isFinite(p.latitude)
        ? {
            label: [
              Math.round(p.longitude * 1000) / 1000,
              Math.round(p.latitude * 1000) / 1000,
            ],
          }
        : {}),
      ...(unit.decimals !== params.decimals ? { d: unit.decimals } : {}),
      polygons: encodeUnit(unit),
    });
  }
  features.sort(
    (a, b) =>
      a.country.localeCompare(b.country) ||
      a.name.localeCompare(b.name) ||
      (a.iso || '').localeCompare(b.iso || ''),
  );
  return {
    meta: {
      title: 'Natural Earth admin-1 states and provinces',
      source: 'ne_10m_admin_1_states_provinces',
      url: SOURCES.admin1.url,
      sha256: source.digest,
      ambiguitySource: SOURCES.places.url,
      ambiguitySha256: places.digest,
      commit: NE_COMMIT,
      license:
        'Public domain (https://www.naturalearthdata.com/about/terms-of-use/)',
      schema:
        'features[]: name, nameEn?, alt?[], postal?, type, rank? (min_label: the zoom at which Natural Earth labels the unit; lower is more prominent), country, iso2, iso (ISO 3166-2), amb?[] (normalized names that are also a country or a city — alone or with the country named), ambAbroad?[] (names shared only with a city in another country — ambiguous alone, settled by naming the country), cityState? (the unit is its own city), label? [lon, lat] label point, d? (decimals when not meta.decimals), polygons[][ring] (first ring outer, rest holes; each ring open and encoded as integers in 10^-d degrees, first vertex absolute then [dLon, dLat] deltas)',
      decimals: params.decimals,
      curation: { ...params, ambiguity },
      script: 'scripts/build-admin-packs.mjs',
    },
    features,
  };
}

async function buildCounties() {
  const params = PARAMS.counties;
  const source = await fetchPinned('counties');
  const files = unzip(source.bytes);
  const base = path.basename(new URL(SOURCES.counties.url).pathname, '.zip');
  const shapes = readShp(files.get(`${base}.shp`));
  const records = readDbf(files.get(`${base}.dbf`));
  if (shapes.length !== records.length)
    throw new Error('counties: shp/dbf record counts differ');
  const features = [];
  records.forEach((record, index) => {
    const unit = simplifyUnit(shpPolygons(shapes[index]), params);
    if (!unit.polygons.length) return;
    const lsad = record.NAMELSAD.startsWith(record.NAME)
      ? record.NAMELSAD.slice(record.NAME.length).trim()
      : '';
    features.push({
      name: record.NAME,
      full: record.NAMELSAD,
      ...(lsad ? { lsad } : {}),
      state: record.STATE_NAME,
      st: record.STUSPS,
      geoid: record.GEOID,
      ...(unit.decimals !== params.decimals ? { d: unit.decimals } : {}),
      polygons: encodeUnit(unit),
    });
  });
  features.sort((a, b) => a.geoid.localeCompare(b.geoid));
  return {
    meta: {
      title: 'US Census Bureau cartographic boundary counties',
      source: base,
      url: SOURCES.counties.url,
      sha256: source.digest,
      license: 'Public domain (U.S. Government work, 17 U.S.C. § 105)',
      schema:
        'features[]: name, full (NAMELSAD), lsad? (County, Parish, Borough, …), state, st (USPS), geoid, d? (decimals when not meta.decimals), polygons[][ring] (first ring outer, rest holes; each ring open and encoded as integers in 10^-d degrees, first vertex absolute then [dLon, dLat] deltas)',
      decimals: params.decimals,
      curation: params,
      script: 'scripts/build-admin-packs.mjs',
    },
    features,
  };
}

async function writePack(relative, pack) {
  const file = path.join(ROOT, relative);
  await mkdir(path.dirname(file), { recursive: true });
  const text = JSON.stringify(pack) + '\n';
  await writeFile(file, text);
  const parts = pack.features.reduce((n, f) => n + f.polygons.length, 0);
  const vertices = pack.features.reduce(
    (n, f) => n + f.polygons.flat().reduce((m, ring) => m + ring.length / 2, 0),
    0,
  );
  console.log(
    `${relative}: ${pack.features.length} features, ${parts} parts, ${vertices} vertices, ${Buffer.byteLength(text)} bytes`,
  );
}

if (!only || only === 'countries')
  await writePack(
    'src/data/local_data/natural_earth/countries.json',
    await buildCountries(),
  );
if (!only || only === 'admin1')
  await writePack(
    'src/data/local_data/natural_earth/states_provinces.json',
    await buildAdmin1(),
  );
if (!only || only === 'counties')
  await writePack(
    'src/data/local_data/us_census_counties/counties.json',
    await buildCounties(),
  );
