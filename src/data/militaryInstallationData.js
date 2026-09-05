/**
 * Normalize the deliberately small, allow-listed installation context returned
 * by `/api/military-installations`. These are mapped features, not assertions
 * about a facility's capability, occupancy, or operational status.
 */

const CLASS_BY_MILITARY_TAG = {
  airfield: 'airfield',
  naval_base: 'naval_base',
  range: 'range',
  barracks: 'military_land',
  base: 'military_land',
};

/**
 * How an UNNAMED feature reads on the map (owner playtest 2026-08-18: the old
 * fallback surfaced "range (10981656305)" — an OSM primary key shown to a human
 * as if it were a place name).
 *
 * Only the classes CLASS_BY_MILITARY_TAG can actually produce need an entry;
 * anything else title-cases its class, which already reads correctly for plain
 * nouns. The OSM id is not lost — it stays on `id` and on `sources[].id`, where
 * attribution and the details panel read it.
 */
const LABEL_BY_CLASS = {
  airfield: 'Military airfield',
  naval_base: 'Naval base',
  range: 'Firing range',
  military_land: 'Military land',
};

const MAX_FOOTPRINT_POINTS = 400;

/**
 * Human-readable label for an unnamed feature's class.
 * @param {string} klass Installation class.
 * @returns {string} Display label, never empty.
 */
export function humanizeInstallationClass(klass) {
  const key = String(klass || '').trim().toLowerCase();
  if (LABEL_BY_CLASS[key]) return LABEL_BY_CLASS[key];
  const words = key.replaceAll('_', ' ').trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : 'Mapped installation';
}

function finiteLatitude(value) {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function finiteLongitude(value) {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

function pointFrom(element) {
  const lat = Number(element?.lat ?? element?.center?.lat);
  const longitude = Number(element?.lon ?? element?.center?.lon);
  if (finiteLatitude(lat) && finiteLongitude(longitude)) return { latitude: lat, longitude };

  // Bounds midpoint fallback (field test 2026-08-28, Warendorf: nothing drawn).
  // The proxy asks for `out center tags geom`, but Overpass takes the LAST
  // geometry mode only — `geom` wins and no `center` is ever emitted. Every
  // way and relation therefore arrived point-less and was dropped here, so the
  // layer rendered nodes and nothing else (San Diego: 149 of 228 kept, all the
  // ways and relations gone; Warendorf has no nodes at all, hence an empty
  // screen over a mapped Bundeswehr barracks). `bounds` accompanies exactly
  // those elements — including relations, which carry no `geometry` — so it
  // recovers all of them without touching the query or the footprint path.
  const bounds = element?.bounds;
  // JSON nulls, booleans, and empty strings must not coerce to a false 0,0 site.
  if (![bounds?.minlat, bounds?.minlon, bounds?.maxlat, bounds?.maxlon]
    .every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const south = Number(bounds?.minlat);
  const west = Number(bounds?.minlon);
  const north = Number(bounds?.maxlat);
  const east = Number(bounds?.maxlon);
  // Ordering matters as much as range: an inverted or antimeridian-spanning
  // box midpoints to a plausible-looking point in the wrong ocean, so match
  // isValidInstallationBoundingBox and refuse it rather than average it.
  // A single installation footprint is never wider than the request bbox cap
  // (10°): an ascending box that spans the antimeridian (minlon -179, maxlon
  // 179) passes the ordering check yet midpoints to longitude 0.
  if (finiteLatitude(south) && finiteLatitude(north)
      && finiteLongitude(west) && finiteLongitude(east)
      && south <= north && west <= east
      && north - south <= 10 && east - west <= 10) {
    return { latitude: (south + north) / 2, longitude: (west + east) / 2 };
  }
  return null;
}

function footprintFrom(element) {
  if (!Array.isArray(element?.geometry) || element.geometry.length < 3 || element.geometry.length > MAX_FOOTPRINT_POINTS) return null;
  const points = [];
  for (const point of element.geometry) {
    const latitude = Number(point?.lat);
    const longitude = Number(point?.lon);
    if (!finiteLatitude(latitude) || !finiteLongitude(longitude)) return null;
    points.push([longitude, latitude]);
  }
  return points;
}

/**
 * Convert a safe, server-filtered Overpass payload into display records.
 * @param {{elements?: Array}} payload
 * @param {string} [retrievedAt]
 * @returns {{records: Array, droppedCount: number}}
 */
export function normalizeMilitaryInstallations(payload, retrievedAt = new Date().toISOString()) {
  const records = [];
  const ids = new Set();
  let droppedCount = 0;
  for (const element of Array.isArray(payload?.elements) ? payload.elements : []) {
    const type = String(element?.type || '');
    const osmId = Number(element?.id);
    if (!['node', 'way', 'relation'].includes(type) || !Number.isSafeInteger(osmId)) {
      droppedCount += 1;
      continue;
    }
    const id = `osm:${type}:${osmId}`;
    const tags = element?.tags || {};
    const klass = CLASS_BY_MILITARY_TAG[String(tags.military || '').toLowerCase()]
      || (tags.landuse === 'military' ? 'military_land' : null);
    const point = pointFrom(element);
    if (!klass || !point || ids.has(id)) {
      droppedCount += 1;
      continue;
    }
    ids.add(id);
    records.push({
      id,
      kind: 'installation',
      // Load-bearing for viewport filtering: a node's centre is its whole
      // geometry, while a footprint-less way/relation has unknown extent.
      osmType: type,
      class: klass,
      name: String(tags.name || tags['name:en'] || '').trim() || humanizeInstallationClass(klass),
      ...point,
      footprint: footprintFrom(element),
      sources: [{ name: 'OpenStreetMap', id: `${type}/${osmId}`, retrievedAt }],
      validation: 'unreviewed',
      retrievedAt,
    });
  }
  return { records, droppedCount };
}

/** @param {unknown} value @returns {boolean} */
export function isValidInstallationBoundingBox(value) {
  const box = value || {};
  const south = Number(box.south);
  const west = Number(box.west);
  const north = Number(box.north);
  const east = Number(box.east);
  return finiteLatitude(south) && finiteLatitude(north) && finiteLongitude(west) && finiteLongitude(east)
    && south < north && west < east && north - south <= 10 && east - west <= 10;
}
