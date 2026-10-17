import { militaryOsmKey } from '../sources/militaryTileGeometry.js';
export { militaryOsmKey } from '../sources/militaryTileGeometry.js';
import { requestWithDeadline } from '../sources/requestDeadline.js';
import { loadBundledJson } from './bundledJson.js';
import { createRetryableLoader } from './retryableLoad.js';

export const MILITARY_POINT_CAP = 512;
export const MILITARY_LABEL_CAP = 24;

export const MILITARY_NAMES_TIMEOUT_MS = 10_000;

/** Map a pack row (optionally carrying a Wikidata item) onto a display record. */
function nameRecord(classes, row) {
  const [
    osmKey,
    name,
    longitude,
    latitude,
    west,
    south,
    east,
    north,
    kind,
    areaM2,
    wikidata,
  ] = row;
  // A supplement row without an OSM identity is a Wikidata position with no
  // mapped military area: it stands alone in close views too.
  const key = osmKey || wikidata;
  return {
    id: osmKey ? `osm:military:${osmKey}` : `wikidata:military:${wikidata}`,
    osmKey: key,
    name,
    longitude,
    latitude,
    bbox: [west, south, east, north],
    class: classes[kind],
    areaM2,
    kind: 'installation',
    namedArea: true,
    pointOnly: true,
    ...(osmKey ? {} : { standalone: true }),
    validation: 'unreviewed',
    sources: [
      ...(osmKey
        ? [
            { name: 'OpenStreetMap', id: osmKey },
            ...(wikidata
              ? []
              : [{ name: 'Overture Maps Foundation', id: osmKey }]),
          ]
        : []),
      ...(wikidata ? [{ name: 'Wikidata', id: wikidata }] : []),
    ],
  };
}

/** Share a bounded acquisition; failed assets become retryable after cooldown. */
export function createMilitaryNamesLoader({
  loadPack = (signal) =>
    loadBundledJson(
      new URL('./local_data/osm_military_names/names.json', import.meta.url),
      { signal },
    ),
  // Curated Norwegian names for areas OpenStreetMap leaves unnamed, plus
  // Wikidata positions for active sites with no mapped area.
  loadSupplements = (signal) =>
    Promise.all([
      loadBundledJson(
        new URL('./local_data/osm_military_names/norway.json', import.meta.url),
        { signal },
      ),
    ]),
  timeoutMs = MILITARY_NAMES_TIMEOUT_MS,
  ...retryOptions
} = {}) {
  return createRetryableLoader(async () => {
    const [pack, supplements] = await requestWithDeadline(
      (signal) => Promise.all([loadPack(signal), loadSupplements(signal)]),
      { timeoutMs },
    );
    const byId = new Map();
    for (const { classes, records } of [pack, ...supplements])
      for (const row of records) {
        const record = nameRecord(classes, row);
        // Supplements only name what the pack leaves unnamed.
        if (!byId.has(record.osmKey)) byId.set(record.osmKey, record);
      }
    const records = [...byId.values()].sort(
      (a, b) => b.areaM2 - a.areaM2 || a.osmKey.localeCompare(b.osmKey),
    );
    return { records, byId };
  }, retryOptions);
}

/** Load and index the separate data asset only when installation context needs it. */
export const loadMilitaryNames = createMilitaryNamesLoader();

/** Join exact source identity before parcel merging; reject geographically inconsistent ids. */
export function nameMilitaryFragment(fragment, names) {
  const osmKey = militaryOsmKey(fragment.featureKey);
  const named = names?.byId.get(osmKey);
  if (!named || !fragment.footprint?.length) return fragment;
  const [west, south, east, north] = named.bbox;
  const epsilon = (fragment.tileEpsilon || 0) * 2 + 0.0001;
  const xs = fragment.footprint.map((p) => p[0]);
  const ys = fragment.footprint.map((p) => p[1]);
  if (
    Math.max(...xs) < west - epsilon ||
    Math.min(...xs) > east + epsilon ||
    Math.max(...ys) < south - epsilon ||
    Math.min(...ys) > north + epsilon
  )
    return fragment;
  return {
    ...fragment,
    name: named.name,
    class: named.class,
    osmKey,
    namedArea: true,
    areaM2: named.areaM2,
    nameRecord: named,
  };
}

/**
 * Area-ranked spatial thinning of visible label points, including dateline
 * views. With `thinned` false every point in the box is kept, up to `cap`.
 */
export function militaryNamesInView(
  names,
  box,
  cap = MILITARY_POINT_CAP,
  thinned = true,
) {
  const width =
    box.east >= box.west ? box.east - box.west : 360 + box.east - box.west;
  const height = box.north - box.south;
  const cells = new Set(),
    records = [];
  let count = 0;
  for (const record of names?.records || []) {
    const x = (record.longitude - box.west + 360) % 360;
    if (x > width || record.latitude < box.south || record.latitude > box.north)
      continue;
    count++;
    const cell = `${Math.min(31, Math.floor((x / width) * 32))}:${Math.min(15, Math.floor(((record.latitude - box.south) / height) * 16))}`;
    if ((thinned && cells.has(cell)) || records.length >= cap) continue;
    cells.add(cell);
    records.push(record);
  }
  return { records, count };
}
