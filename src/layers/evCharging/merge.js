/**
 * Farthest an Open Charge Map site may sit from an OpenStreetMap station and
 * still be taken for the same place. Both sources pin a site by hand, often to
 * a different corner of the same car park; past ~50 m a neighbouring site
 * across the street becomes the likelier match.
 */
export const OCM_MATCH_DISTANCE_M = 50;

const EARTH_RADIUS_M = 6_371_008.8;
const RADIANS = Math.PI / 180;

/** Ground distance in metres, equirectangular: exact enough below a km. */
export function groundDistanceM(a, b) {
  const x =
    (b.longitude - a.longitude) *
    RADIANS *
    Math.cos(((a.latitude + b.latitude) / 2) * RADIANS);
  const y = (b.latitude - a.latitude) * RADIANS;
  return Math.hypot(x, y) * EARTH_RADIUS_M;
}

/**
 * Join Open Charge Map sites onto OpenStreetMap stations.
 *
 * Every pair closer than `maxDistanceM` is a candidate; pairs are taken
 * nearest first and each station and each site is used at most once, so a
 * site between two stations enriches the closer one and two sites never
 * claim one station. A matched station keeps its id, name and position and
 * gains `ocm`; a site left unmatched becomes a station of its own with
 * `origin: 'ocm'`.
 *
 * @param {Array<object>} stations OSM records ({id, name, latitude, longitude}).
 * @param {Array<object>} sites Trimmed OCM sites from `/api/ocm/poi`.
 * @param {{maxDistanceM?: number}} [options]
 * @returns {{records: Array<object>, matched: number, added: number}}
 */
export function mergeOcmSites(
  stations,
  sites,
  { maxDistanceM = OCM_MATCH_DISTANCE_M } = {},
) {
  // Bucket sites in latitude bands one match distance tall, so a station
  // compares only against the sites of its own band and the two beside it.
  const band = maxDistanceM / (EARTH_RADIUS_M * RADIANS);
  const bandOf = (latitude) => Math.floor(latitude / band);
  const buckets = new Map();
  sites.forEach((site, index) => {
    const key = bandOf(site.latitude);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(index);
  });
  const pairs = [];
  stations.forEach((station, stationIndex) => {
    const row = bandOf(station.latitude);
    for (let offset = -1; offset <= 1; offset++)
      for (const siteIndex of buckets.get(row + offset) ?? []) {
        const distance = groundDistanceM(station, sites[siteIndex]);
        if (distance <= maxDistanceM)
          pairs.push({ stationIndex, siteIndex, distance });
      }
  });
  pairs.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.stationIndex - b.stationIndex ||
      a.siteIndex - b.siteIndex,
  );
  const siteFor = new Map();
  const usedSites = new Set();
  for (const { stationIndex, siteIndex } of pairs) {
    if (siteFor.has(stationIndex) || usedSites.has(siteIndex)) continue;
    siteFor.set(stationIndex, sites[siteIndex]);
    usedSites.add(siteIndex);
  }
  const records = stations.map((station, index) =>
    siteFor.has(index) ? { ...station, ocm: siteFor.get(index) } : station,
  );
  let added = 0;
  sites.forEach((site, index) => {
    if (usedSites.has(index)) return;
    added++;
    records.push({
      id: `ev-charging:ocm:${site.id}`,
      name: site.title || null,
      latitude: site.latitude,
      longitude: site.longitude,
      origin: 'ocm',
      ocm: site,
    });
  });
  return { records, matched: siteFor.size, added };
}
