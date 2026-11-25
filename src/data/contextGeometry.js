import { greatCircleKm, isGeoPoint } from '../geoDistance.js';

// Non-enumerable feature data keeps the analyst record's public shape.
export const CONTEXT_LINES = Symbol('Context lines');
export const CONTEXT_FEATURE = Symbol('Context feature');

/**
 * Keep a path's bounds for cheap rejection before reading its drawn vertices.
 * A path that wraps the date line skips the longitude rejection.
 */
export function contextLine(vertices, draw = () => vertices) {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  let wraps = false;
  let previousLon;
  for (const vertex of vertices) {
    if (!isGeoPoint(vertex)) continue;
    const { lat, lon } = vertex;
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    if (Math.abs(lon - previousLon) > 180) wraps = true;
    previousLon = lon;
  }
  let points;
  return Object.freeze({
    bounds: {
      west: wraps ? -180 : west,
      east: wraps ? 180 : east,
      south,
      north,
    },
    points() {
      if (!points)
        points = Object.freeze(draw().filter(isGeoPoint).map(Object.freeze));
      return points;
    },
  });
}

function longitudeDelta(delta) {
  if (delta > 180) return delta - 360;
  if (delta < -180) return delta + 360;
  return delta;
}

function longitudePieces(dx) {
  return Math.max(1, Math.ceil(Math.abs(dx) / 30));
}

/** Minimize distance along short pieces of the actual latitude/longitude path. */
function closestParameter(a, dx, dy, center, distanceAt, start = 0, end = 1) {
  if (start === end || (!dx && !dy)) return start;
  // A meridian or parallel has an analytic minimum on the sphere.
  if (!dx || !dy) {
    const rad = Math.PI / 180;
    const lon = longitudeDelta(center.lon - a.lon);
    const centerLat = center.lat * rad;
    const closestLat =
      Math.atan2(
        Math.sin(centerLat),
        Math.cos(centerLat) * Math.cos(lon * rad),
      ) / rad;
    const exact = dx ? lon / dx : (closestLat - a.lat) / dy;
    if (exact >= start && exact <= end) return exact;
    return distanceAt(start) <= distanceAt(end) ? start : end;
  }
  const span = end - start;
  // A physically short polar edge can span a large longitude interval.
  const pieces = longitudePieces(dx * span);
  let best = start;
  let bestKm = distanceAt(start);
  const consider = (t) => {
    const km = distanceAt(t);
    if (km < bestKm) {
      best = t;
      bestKm = km;
    }
  };
  for (let piece = 0; piece < pieces; piece++) {
    let left = start + (piece / pieces) * span;
    let right =
      piece + 1 === pieces ? end : start + ((piece + 1) / pieces) * span;
    consider(right);
    for (let step = 0; step < 32; step++) {
      const nextLeft = (2 * left + right) / 3;
      const nextRight = (left + 2 * right) / 3;
      if (distanceAt(nextLeft) < distanceAt(nextRight)) right = nextRight;
      else left = nextLeft;
    }
    consider((left + right) / 2);
  }
  return best;
}

/** Upper bound on the distance travelled along a segment in degrees. */
function segmentLengthBound(aLat, bLat, dx) {
  const low = Math.min(aLat, bLat);
  const high = Math.max(aLat, bLat);
  const nearestEquator = Math.max(low, Math.min(high, 0));
  return (
    112 *
    (high - low + Math.abs(dx) * Math.cos((nearestEquator * Math.PI) / 180))
  );
}

/** Find a nearby line anchor using spherical distances to its drawn path. */
export function linePointWithinRadius(paths, center, radiusKm) {
  // A degree of latitude is at least 110.5 km (at the equator), so this span is never too small.
  const latitudeSpan = radiusKm / 110;
  const south = center.lat - latitudeSpan;
  const north = center.lat + latitudeSpan;
  let best = null;
  let bestKm = radiusKm;
  const consider = (point, km) => {
    if (km <= bestKm && (!best || km < bestKm)) {
      best = point;
      bestKm = km;
    }
  };
  for (const { bounds, points } of paths) {
    if (bounds.north < south || bounds.south > north) continue;
    const path = points();
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const low = Math.min(a.lat, b.lat);
      const high = Math.max(a.lat, b.lat);
      if (high < south || low > north) continue;
      const dx = longitudeDelta(b.lon - a.lon);
      const dy = b.lat - a.lat;
      const aKm = greatCircleKm(center, a);
      const bKm = greatCircleKm(center, b);
      consider(a, aKm);
      consider(b, bKm);
      // The sum of the distances from a point on the segment to its ends
      // cannot exceed this bound on travel along the latitude/longitude path.
      const maxSegmentKm = segmentLengthBound(a.lat, b.lat, dx);
      if (!maxSegmentKm || aKm + bKm - maxSegmentKm > 2 * bestKm) continue;
      const at = (t) => ({
        lat: a.lat + t * dy,
        lon: longitudeDelta(a.lon + t * dx),
      });
      const nearest = at(
        closestParameter(a, dx, dy, center, (t) =>
          greatCircleKm(center, at(t)),
        ),
      );
      consider(nearest, greatCircleKm(center, nearest));
    }
  }
  return best;
}

/**
 * Closest point to the view centre on the part of a drawn path inside the
 * rectangle. Paths use the renderer's rhumb vertices in degrees. Clip each
 * segment in its own unwrapped longitude interval across the date line.
 */
export function linePointInRect(paths, rect, center, spherical = false) {
  if (!paths) return null;
  const { west, south, north } = rect;
  const east = rect.east < west ? rect.east + 360 : rect.east;
  const lonWeight = Math.cos((center.lat * Math.PI) / 180) ** 2;
  let best = null;
  let bestKm = Infinity;
  if (![west, east, south, north].every(Number.isFinite)) return null;
  for (const { bounds, points } of paths) {
    if (bounds.north < south || bounds.south > north) continue;
    const shift = 360 * Math.ceil((bounds.west - east) / 360);
    if (west + shift > bounds.east) continue;
    const path = points();
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      if (Math.max(a.lat, b.lat) < south || Math.min(a.lat, b.lat) > north)
        continue;
      const dy = b.lat - a.lat;
      const dx = longitudeDelta(b.lon - a.lon);
      const xEnd = a.lon + dx;
      const left = Math.min(a.lon, xEnd);
      const right = Math.max(a.lon, xEnd);
      const firstShift = 360 * Math.ceil((left - east) / 360);
      const alongLat = dy ? (south - a.lat) / dy : 0;
      const toLat = dy ? (north - a.lat) / dy : 1;
      for (
        let shift = firstShift, copies = 0;
        copies < 3 && west + shift <= right;
        shift += 360, copies++
      ) {
        const alongLon = dx ? (west + shift - a.lon) / dx : 0;
        const toLon = dx ? (east + shift - a.lon) / dx : 1;
        const start = Math.max(
          0,
          Math.min(alongLat, toLat),
          Math.min(alongLon, toLon),
        );
        const end = Math.min(
          1,
          Math.max(alongLat, toLat),
          Math.max(alongLon, toLon),
        );
        if (start > end) continue;
        let t;
        if (spherical) {
          const at = (fraction) => ({
            lat: a.lat + fraction * dy,
            lon: longitudeDelta(a.lon + fraction * dx),
          });
          const from = at(start);
          const to = at(end);
          const fromKm = greatCircleKm(center, from);
          const toKm = greatCircleKm(center, to);
          const maxSegmentKm = segmentLengthBound(
            from.lat,
            to.lat,
            dx * (end - start),
          );
          if (fromKm + toKm - maxSegmentKm > 2 * bestKm) continue;
          t = closestParameter(
            a,
            dx,
            dy,
            center,
            (fraction) => greatCircleKm(center, at(fraction)),
            start,
            end,
          );
        } else {
          const squareLength = dx * dx * lonWeight + dy * dy;
          const nearest = squareLength
            ? (dx * longitudeDelta(center.lon - a.lon) * lonWeight +
                dy * (center.lat - a.lat)) /
              squareLength
            : start;
          t = Math.max(start, Math.min(end, nearest));
        }
        let lon = longitudeDelta(a.lon + t * dx);
        if (lon === 180 && rect.east < 180 && rect.west === -180) lon = -180;
        if (lon === -180 && rect.west > -180 && rect.east === 180) lon = 180;
        const at = { lat: a.lat + t * dy, lon };
        const km = greatCircleKm(center, at);
        if (km < bestKm) {
          best = at;
          bestKm = km;
        }
      }
    }
  }
  return best;
}

/** Find the nearest rendered line point on the camera's visible ground cap. */
export function linePointInCap(paths, center, eye, radiusKm, scoreInView) {
  const latitudeSpan = radiusKm / 110;
  const south = eye.lat - latitudeSpan;
  const north = eye.lat + latitudeSpan;
  let best = null;
  let bestScore = -Infinity;
  let bestKm = Infinity;
  const consider = (at) => {
    const score = scoreInView(at);
    if (score > bestScore) {
      best = at;
      bestScore = score;
      bestKm = greatCircleKm(center, at);
    }
    return score;
  };
  for (const { bounds, points } of paths) {
    if (bounds.north < south || bounds.south > north) continue;
    const path = points();
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const dx = longitudeDelta(b.lon - a.lon);
      const dy = b.lat - a.lat;
      const at = (t) => ({
        lat: a.lat + t * dy,
        lon: longitudeDelta(a.lon + t * dx),
      });
      const pieces = longitudePieces(dx);
      for (let j = 0; j < pieces; j++) {
        const start = j / pieces;
        const end = (j + 1) / pieces;
        const from = at(start);
        const to = at(end);
        const fromVisible = consider(from) !== -Infinity;
        const toVisible = consider(to) !== -Infinity;
        const maxSegmentKm = segmentLengthBound(from.lat, to.lat, dx / pieces);
        if (
          !maxSegmentKm ||
          greatCircleKm(center, from) +
            greatCircleKm(center, to) -
            maxSegmentKm >
            2 * bestKm
        )
          continue;
        if (
          !fromVisible &&
          !toVisible &&
          greatCircleKm(eye, from) > radiusKm + maxSegmentKm
        )
          continue;

        const target = closestParameter(
          a,
          dx,
          dy,
          center,
          (t) => greatCircleKm(center, at(t)),
          start,
          end,
        );
        if (consider(at(target)) !== -Infinity) continue;

        // The best point may be hidden, with a visible interval on either
        // side. Keep the clipped anchor inside the cap when approaching it.
        const clipTowardsTarget = (visible) => {
          let hidden = target;
          for (let step = 0; step < 16; step++) {
            const middle = (visible + hidden) / 2;
            if (consider(at(middle)) === -Infinity) hidden = middle;
            else visible = middle;
          }
        };
        if (fromVisible) clipTowardsTarget(start);
        if (toVisible) clipTowardsTarget(end);
        if (!fromVisible && !toVisible) {
          // A line can cross the cap even when neither endpoint is visible.
          const visible = closestParameter(
            a,
            dx,
            dy,
            eye,
            (t) => greatCircleKm(eye, at(t)),
            start,
            end,
          );
          if (consider(at(visible)) !== -Infinity) clipTowardsTarget(visible);
        }
      }
    }
  }
  return best;
}
