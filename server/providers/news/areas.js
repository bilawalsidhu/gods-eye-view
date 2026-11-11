// Areas for the News layer, from the bundled Natural Earth packs (public
// domain): the disputed area or else the country at a point, its outline in
// the /api/news/outline form, and a point inside a country to pin its
// national news at. A disputed area is checked first and named as itself,
// so no one country's name stands for it; so is a territory the countries
// pack gives no code (Somaliland), rather than read as sea. Read once, on
// first use.

import { readFileSync } from 'node:fs';

import {
  containsAnchor,
  geometryOf,
  pointInRing,
} from '../../../src/data/adminBoundaries.js';

const PACKS = '../../../src/data/local_data/natural_earth/';
const PACK = new URL(`${PACKS}countries.json`, import.meta.url);
const DISPUTED = new URL(`${PACKS}disputed_areas.json`, import.meta.url);
const ISO2 = /^[A-Z]{2}$/;

let countries = null;
let territories = [];

/**
 * One entry per ISO code: its name and every Country part's geometry. The
 * Country features without a code ("-99": Somaliland, Northern Cyprus,
 * sovereign base areas, no man's lands) are kept apart as territories.
 */
function loadCountries(read = () => JSON.parse(readFileSync(PACK, 'utf8'))) {
  if (countries) return countries;
  const pack = read();
  const decimals = pack.meta?.decimals ?? 3;
  const byCode = new Map();
  const codeless = [];
  for (const feature of pack.features || []) {
    // The constituent countries of the United Kingdom repeat its part.
    if (feature.type !== 'Country') continue;
    if (!ISO2.test(feature.iso2 || '')) {
      if (feature.name)
        codeless.push({ name: feature.name, feature, decimals });
      continue;
    }
    const entry = byCode.get(feature.iso2) || {
      code: feature.iso2,
      name: null,
      size: 0,
      parts: [],
    };
    entry.parts.push({ feature, decimals });
    // Named after its largest feature: Kazakhstan, not the Baikonur lease.
    const size = JSON.stringify(feature.polygons).length;
    if (size > entry.size) {
      entry.name = feature.name;
      entry.size = size;
    }
    byCode.set(feature.iso2, entry);
  }
  countries = byCode;
  territories = codeless;
  return countries;
}

/** Test seam: read another pack (or the bundled one again). */
export function resetCountries(read) {
  countries = null;
  if (read) loadCountries(read);
}

const geometries = (entry) => entry.parts.map((part) => geometryOf(part));

let disputed = null;
const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** The disputed areas: `{key, name, kind, heldBy, claimedBy, rings}`. */
function loadDisputed() {
  if (disputed) return disputed;
  const pack = JSON.parse(readFileSync(DISPUTED, 'utf8'));
  disputed = (pack.areas || []).map((area) => ({
    key: `disputed-${slug(area.name)}`,
    name: area.name,
    kind: area.kind,
    heldBy: area.heldBy ?? null,
    claimedBy: area.claimedBy ?? null,
    rings: area.rings,
  }));
  return disputed;
}

/** The disputed area at a point, or null. */
export function disputedAt(lat, lon) {
  return (
    loadDisputed().find((area) =>
      area.rings.some((ring) => pointInRing(ring, lat, lon)),
    ) || null
  );
}

/**
 * The area a point is in, as the News layer names it: a disputed area, or
 * a territory without a code, as itself (`kind: 'disputed'`, `code` null),
 * else its country (`kind: 'country'`, with `country` the countryAt
 * entry); null at sea.
 */
export function areaAt(lat, lon) {
  const area = disputedAt(lat, lon);
  if (area)
    return {
      ...area,
      kind: 'disputed',
      held: area.kind,
      code: null,
      polygons: area.rings.map((outer) => ({ outer, holes: [] })),
    };
  const country = countryAt(lat, lon);
  if (country)
    return {
      key: country.code,
      name: country.name,
      kind: 'country',
      code: country.code,
      country,
    };
  const territory = territoryAt(lat, lon);
  return territory
    ? {
        key: `disputed-${slug(territory.name)}`,
        name: territory.name,
        kind: 'disputed',
        held: null,
        code: null,
        polygons: geometryOf(territory).polygons.map(([outer, ...holes]) => ({
          outer,
          holes,
        })),
      }
    : null;
}

/** Whether a point lies in a geometry (geometryOf), across the antimeridian. */
function inGeometry(geometry, lat, lon) {
  const [west, south, east, north] = geometry.bbox;
  const x = lon - 360 * Math.round((lon - (west + east) / 2) / 360);
  if (x < west || x > east || lat < south || lat > north) return false;
  return containsAnchor(geometry.polygons, lat, lon);
}

/** The country at a point, or null at sea or in a territory without a code. */
export function countryAt(lat, lon) {
  for (const entry of loadCountries().values())
    for (const geometry of geometries(entry))
      if (inGeometry(geometry, lat, lon)) return entry;
  return null;
}

/** The territory without a code at a point (Somaliland), or null. */
function territoryAt(lat, lon) {
  loadCountries();
  return (
    territories.find((part) => inGeometry(geometryOf(part), lat, lon)) || null
  );
}

/** A country by its ISO code, or null. */
export const countryByCode = (code) => loadCountries().get(code) || null;

/**
 * A country's outline as /api/news/outline answers it (`{outer, holes}`),
 * the disputed areas inside it left out as holes (Russia's without Crimea).
 */
export function countryPolygons(entry) {
  const areas = loadDisputed();
  return geometries(entry).flatMap((geometry) =>
    geometry.polygons.map(([outer, ...holes]) => ({
      outer,
      holes: [
        ...holes,
        ...areas
          .flatMap((area) => area.rings)
          // By a point inside it: its corners lie on the neighbours' borders.
          .filter((ring) => {
            const inside = ringInterior(ring);
            return inside && pointInRing(outer, inside.lat, inside.lon);
          }),
      ],
    })),
  );
}

/**
 * A point inside the country's largest part, for news placed in the country
 * alone: its label point when that lies inside, else the middle of the
 * widest span across the part at its middle latitude.
 */
export function countryAnchor(entry) {
  const largest = geometries(entry).sort((a, b) => b.areaKm2 - a.areaKm2)[0];
  const { label, polygons, bbox } = largest;
  if (containsAnchor(polygons, label.lat, label.lon)) return label;
  const [outer] = polygons.reduce((a, b) =>
    b[0].length > a[0].length ? b : a,
  );
  return ringInterior(outer, (bbox[1] + bbox[3]) / 2) || label;
}

/**
 * A point inside a ring: the middle of its widest span at `lat` (its middle
 * latitude by default); null when the ring is not crossed there.
 */
function ringInterior(outer, lat = middleLat(outer)) {
  const crossings = [];
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const [x1, y1] = outer[j];
    const [x2, y2] = outer[i];
    if (y1 > lat !== y2 > lat)
      crossings.push(x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1));
  }
  crossings.sort((a, b) => a - b);
  let best = null;
  for (let i = 0; i + 1 < crossings.length; i += 2)
    if (!best || crossings[i + 1] - crossings[i] > best[1] - best[0])
      best = [crossings[i], crossings[i + 1]];
  return best ? { lat, lon: (best[0] + best[1]) / 2 } : null;
}

const middleLat = (ring) => {
  const lats = ring.map(([, y]) => y);
  return (Math.min(...lats) + Math.max(...lats)) / 2;
};
