import { BHOTE_KOSHI_FLOOD_PATH } from './bhoteKoshiFloodPath.js';

export const SOURCE_PATH_BEAT_IDS = Object.freeze([
  'debris-dammed-lake',
  'second-landslide',
  'dhunche',
  'mailung-upper-trishuli',
  'mailung-bazzar',
  'dandagaun',
  'dandagaun-viewpoint',
  'betrawati-bazaar',
  'bhainse',
  'bidur-trishuli-bridge',
]);

function nearestVertex(point, route) {
  if (!point || !Number.isFinite(point.lon) || !Number.isFinite(point.lat))
    return -1;
  const longitudeScale = Math.cos((point.lat * Math.PI) / 180);
  let nearest = -1;
  let distance = 1000; // Witness viewpoints can sit beside the river, not on it.
  route.forEach(([lon, lat], index) => {
    const metres =
      Math.hypot((lon - point.lon) * longitudeScale, lat - point.lat) * 111195;
    if (metres < distance) {
      distance = metres;
      nearest = index;
    }
  });
  return nearest;
}

/** Split the already-bundled GeoPera centreline; never connect witness pins. */
export function buildSourceShotPaths(event, route = BHOTE_KOSHI_FLOOD_PATH) {
  const observations = new Map(
    (event.evidenceSpine || []).map((point) => [point.id, point]),
  );
  const result = new Map();
  const add = (id, from, to, { joinComparison = false } = {}) => {
    let start = nearestVertex(from, route);
    const end = nearestVertex(to, route);
    if (start < 0 || end <= start) return;
    const startHeight = from.fallbackElevationM ?? from.elevationM;
    const endHeight = to.fallbackElevationM ?? to.elevationM;
    if (!Number.isFinite(startHeight) || !Number.isFinite(endHeight)) return;
    if (joinComparison) {
      // The raster corridor ends between simplified centreline vertices.
      // Snapping to its nearest vertex can move the head upstream on entry.
      // Keep that already-sourced endpoint and continue to the next vertex
      // downstream of it, rather than replaying the upstream half-segment.
      const [lon, lat] = route[start];
      const [nextLon, nextLat] = route[start + 1];
      const scale = Math.cos((from.lat * Math.PI) / 180);
      const along =
        (from.lon - lon) * (nextLon - lon) * scale * scale +
        (from.lat - lat) * (nextLat - lat);
      if (along > 0) start++;
    }
    const coordinates = route.slice(start, end + 1);
    if (
      joinComparison &&
      (coordinates[0][0] !== from.lon || coordinates[0][1] !== from.lat)
    ) {
      coordinates.unshift([from.lon, from.lat]);
    }
    result.set(
      id,
      coordinates.map(([lon, lat], index) => ({
        lon,
        lat,
        // Stable source profile for explicit source-elevation shots; otherwise a
        // fallback when neither rendered mesh nor elevation terrain can be sampled.
        fallbackElevationM:
          startHeight +
          ((endHeight - startHeight) * index) / (coordinates.length - 1),
      })),
    );
  };
  add(
    'debris-dammed-lake',
    observations.get('debris-dammed-lake'),
    observations.get('second-landslide'),
  );
  add(
    'second-landslide',
    observations.get('second-landslide'),
    observations.get('gyirong-border-gate'),
  );
  let previous = event.reconstruction?.corridor?.at(-1);
  for (const id of SOURCE_PATH_BEAT_IDS.slice(2)) {
    const point = observations.get(id);
    add(id, previous, point, { joinComparison: id === 'dhunche' });
    // Missing coverage breaks continuity rather than inventing a long connector.
    previous = point;
  }
  return result;
}
