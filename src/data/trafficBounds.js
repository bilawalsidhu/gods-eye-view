/**
 * @file Pure geometry helpers for the traffic layer's viewport fetch bounds.
 *
 * C4 fix (2026-07-16): `camera.computeViewRectangle()` spans toward the horizon
 * at oblique pitch, and centering the fetch box on the RECTANGLE MIDPOINT put
 * road fetches tens of km from what the user is actually looking at. The fetch
 * center is now derived from the camera's look-at ground point
 * (`camera.pickEllipsoid` at canvas center — the globe is hidden under Google
 * 3D tiles, so `scene.globe.pick` is not reliable), falling back to the camera
 * nadir, and pulled back toward nadir when the look-at point is beyond a
 * horizon-gaze cap. Kept Cesium-free so it can be unit-tested with node:test.
 *
 * @module data/trafficBounds
 */

/** @const {number} Mean Earth radius in km (spherical approximation). */
const EARTH_RADIUS_KM = 6371;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/**
 * Great-circle distance between two lat/lon points (haversine).
 *
 * @param {number} lat1 - First point latitude (degrees).
 * @param {number} lon1 - First point longitude (degrees).
 * @param {number} lat2 - Second point latitude (degrees).
 * @param {number} lon2 - Second point longitude (degrees).
 * @returns {number} Distance in kilometres.
 */
export function greatCircleKm(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1);
  const dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Initial bearing (radians) from point 1 toward point 2 along the great circle.
 *
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 * @returns {number} Bearing in radians (0 = north, clockwise).
 */
function initialBearingRad(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return Math.atan2(y, x);
}

/**
 * Destination point given a start, an initial bearing, and a distance
 * (spherical direct geodesic).
 *
 * @param {number} lat - Start latitude (degrees).
 * @param {number} lon - Start longitude (degrees).
 * @param {number} bearingRad - Initial bearing (radians, 0 = north).
 * @param {number} distKm - Distance to travel (km).
 * @returns {{lat:number, lon:number}} Destination in degrees.
 */
function destinationPoint(lat, lon, bearingRad, distKm) {
  const delta = distKm / EARTH_RADIUS_KM;
  const p1 = toRad(lat);
  const l1 = toRad(lon);
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(delta) + Math.cos(p1) * Math.sin(delta) * Math.cos(bearingRad)
  );
  const l2 = l1 + Math.atan2(
    Math.sin(bearingRad) * Math.sin(delta) * Math.cos(p1),
    Math.cos(delta) - Math.sin(p1) * Math.sin(p2)
  );
  // Normalize longitude to [-180, 180)
  const lonDeg = ((toDeg(l2) + 540) % 360) - 180;
  return { lat: toDeg(p2), lon: lonDeg };
}

/**
 * Derive the road-fetch center from the camera's look-at ground point.
 *
 * Rules:
 *  - No usable hit (pickEllipsoid returned undefined → non-finite hit coords):
 *    fall back to the camera nadir.
 *  - Hit within `maxPullKm` of nadir: use the hit verbatim (normal oblique view).
 *  - Hit farther than `maxPullKm` (horizon gaze): pull it back toward nadir to
 *    exactly `maxPullKm` along the nadir→hit great-circle bearing. Traffic only
 *    activates below 8 km camera altitude, so a look-at point farther than
 *    ~12 km is horizon-gazing, not something the user can see roads at.
 *
 * @param {Object} args
 * @param {number} args.nadirLat - Camera nadir latitude (degrees).
 * @param {number} args.nadirLon - Camera nadir longitude (degrees).
 * @param {number} [args.hitLat] - pickEllipsoid ground-hit latitude (degrees), if any.
 * @param {number} [args.hitLon] - pickEllipsoid ground-hit longitude (degrees), if any.
 * @param {number} [args.maxPullKm=12] - Max great-circle distance from nadir.
 * @returns {{lat:number, lon:number, source:'hit'|'nadir'|'pulled'}}
 *   The fetch center and which rule produced it.
 */
export function deriveFetchCenter({ nadirLat, nadirLon, hitLat, hitLon, maxPullKm = 12 }) {
  if (!Number.isFinite(hitLat) || !Number.isFinite(hitLon)) {
    return { lat: nadirLat, lon: nadirLon, source: 'nadir' };
  }
  const distKm = greatCircleKm(nadirLat, nadirLon, hitLat, hitLon);
  if (distKm <= maxPullKm) {
    return { lat: hitLat, lon: hitLon, source: 'hit' };
  }
  const bearing = initialBearingRad(nadirLat, nadirLon, hitLat, hitLon);
  const pulled = destinationPoint(nadirLat, nadirLon, bearing, maxPullKm);
  return { lat: pulled.lat, lon: pulled.lon, source: 'pulled' };
}

/**
 * Clamp a bounding box's spans to `maxSpanDeg` and recenter it on `center`.
 *
 * Preserves the pre-C4 span semantics (each axis capped at 0.05° ≈ 5.5 km)
 * but centers the box on the derived look-at point instead of the view
 * rectangle's midpoint. Idempotent when `center` is the box's own midpoint.
 *
 * @param {{south:number, west:number, north:number, east:number}} bounds
 *   Source bounds (span donor).
 * @param {{lat:number, lon:number}} center - Fetch center (degrees).
 * @param {number} [maxSpanDeg=0.05] - Max span per axis in degrees.
 * @returns {{south:number, west:number, north:number, east:number}} Clamped bounds.
 */
export function clampBoundsAroundCenter(bounds, center, maxSpanDeg = 0.05) {
  const latSpan = Math.min(bounds.north - bounds.south, maxSpanDeg);
  const lonSpan = Math.min(bounds.east - bounds.west, maxSpanDeg);
  return {
    south: center.lat - latSpan / 2,
    north: center.lat + latSpan / 2,
    west: center.lon - lonSpan / 2,
    east: center.lon + lonSpan / 2,
  };
}

/**
 * Check if a lat/lon coordinate falls inside bounding box.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {{south:number, west:number, north:number, east:number}} bounds
 * @returns {boolean}
 */
export function isCoordInBounds(lat, lon, bounds) {
  if (!bounds) return false;
  return lat >= bounds.south && lat <= bounds.north &&
         lon >= bounds.west && lon <= bounds.east;
}

/**
 * Check if a road's polyline intersects or touches a bounding box.
 *
 * @param {{coords:number[][]}} road - Road object with coords as [lon, lat] pairs.
 * @param {{south:number, west:number, north:number, east:number}} bounds
 * @returns {boolean}
 */
export function roadIntersectsBounds(road, bounds) {
  if (!bounds || !road?.coords?.length) return false;
  let rSouth = Infinity, rNorth = -Infinity, rWest = Infinity, rEast = -Infinity;
  for (let i = 0; i < road.coords.length; i++) {
    const [lon, lat] = road.coords[i];
    if (lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east) {
      return true;
    }
    if (lat < rSouth) rSouth = lat;
    if (lat > rNorth) rNorth = lat;
    if (lon < rWest) rWest = lon;
    if (lon > rEast) rEast = lon;
  }
  return !(rNorth < bounds.south || rSouth > bounds.north || rEast < bounds.west || rWest > bounds.east);
}

const ROAD_TYPE_PRIORITY = {
  motorway: 6,
  trunk: 5,
  primary: 4,
  secondary: 3,
  tertiary: 2,
  residential: 1,
  unclassified: 0,
};

/**
 * Sort road segments prioritizing:
 *  1. Segments intersecting current visible viewport bounds
 *  2. Proximity to camera fetch center
 *  3. Road class hierarchy (major arterial before residential)
 *
 * @param {Array} roads
 * @param {{south:number, north:number, west:number, east:number}|null} viewBounds
 * @param {{lat:number, lon:number}|null} center
 * @returns {Array} New array with prioritized road order
 */
export function prioritizeRoadsForViewport(roads, viewBounds, center) {
  if (!Array.isArray(roads) || roads.length <= 1) return roads ? [...roads] : [];
  return [...roads].sort((a, b) => {
    const aInView = viewBounds ? roadIntersectsBounds(a, viewBounds) : true;
    const bInView = viewBounds ? roadIntersectsBounds(b, viewBounds) : true;
    if (aInView !== bInView) return aInView ? -1 : 1;

    if (center && Number.isFinite(center.lat) && Number.isFinite(center.lon)) {
      const aCoord = a.coords?.[0];
      const bCoord = b.coords?.[0];
      if (aCoord && bCoord) {
        const aDist = greatCircleKm(center.lat, center.lon, aCoord[1], aCoord[0]);
        const bDist = greatCircleKm(center.lat, center.lon, bCoord[1], bCoord[0]);
        const distDiff = aDist - bDist;
        if (Math.abs(distDiff) > 0.4) {
          return distDiff;
        }
      }
    }

    const aPri = ROAD_TYPE_PRIORITY[a.type] ?? 0;
    const bPri = ROAD_TYPE_PRIORITY[b.type] ?? 0;
    return bPri - aPri;
  });
}

/**
 * Compute the 8 adjacent neighbor bounding boxes around a clamped tile.
 * Cardinal directions (N, S, E, W) come first, followed by diagonals (NE, NW, SE, SW).
 *
 * @param {{south:number, north:number, west:number, east:number}} bounds
 * @returns {Array<{direction:string, bounds:{south:number, north:number, west:number, east:number}}>}
 */
export function computeNeighborRingBounds(bounds) {
  if (!bounds) return [];
  const latSpan = bounds.north - bounds.south;
  const lonSpan = bounds.east - bounds.west;
  const directions = [
    { dir: 'N',  dLat: 1,  dLon: 0 },
    { dir: 'S',  dLat: -1, dLon: 0 },
    { dir: 'E',  dLat: 0,  dLon: 1 },
    { dir: 'W',  dLat: 0,  dLon: -1 },
    { dir: 'NE', dLat: 1,  dLon: 1 },
    { dir: 'NW', dLat: 1,  dLon: -1 },
    { dir: 'SE', dLat: -1, dLon: 1 },
    { dir: 'SW', dLat: -1, dLon: -1 },
  ];
  return directions.map(({ dir, dLat, dLon }) => ({
    direction: dir,
    bounds: {
      south: bounds.south + dLat * latSpan,
      north: bounds.north + dLat * latSpan,
      west: bounds.west + dLon * lonSpan,
      east: bounds.east + dLon * lonSpan,
    },
  }));
}

/**
 * Calculate adaptive dot cap based on instantaneous or smoothed frame time.
 * Covers coverage first (keeps minimum dots), reduces cap when frame drops below 45 FPS (22ms).
 *
 * @param {number} frameTimeMs
 * @param {number} [currentCap=6000]
 * @param {Object} [options]
 * @returns {number}
 */
export function calculateAdaptiveDotCap(frameTimeMs, currentCap = 6000, options = {}) {
  const {
    minCap = 3000,
    maxCap = 6000,
    targetFrameTimeMs = 16.7,
    degradeFrameTimeMs = 22.0,
    stepDown = 300,
    stepUp = 100,
  } = options;

  if (!Number.isFinite(frameTimeMs) || frameTimeMs <= 0) {
    return Math.max(minCap, Math.min(maxCap, currentCap));
  }

  if (frameTimeMs > degradeFrameTimeMs) {
    return Math.max(minCap, currentCap - stepDown);
  } else if (frameTimeMs <= targetFrameTimeMs) {
    return Math.min(maxCap, currentCap + stepUp);
  }
  return currentCap;
}
