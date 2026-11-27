import {
  acosClamped,
  add,
  cross,
  dot,
  magnitude,
  scale,
  sub,
} from '../geo/vector.js';
import { EARTH_RADIUS_KM, greatCircleKm, isGeoPoint } from '../geoDistance.js';

// Non-enumerable feature data keeps the analyst record's public shape.
export const CONTEXT_AREA = Symbol('Context area');
export const CONTEXT_LINES = Symbol('Context lines');
export const CONTEXT_FEATURE = Symbol('Context feature');

/** A point on the unit sphere, for comparing distances with one dot product. */
export function unitVector(lat, lon, out = { x: 0, y: 0, z: 0 }) {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  out.x = cosPhi * Math.cos(lambda);
  out.y = cosPhi * Math.sin(lambda);
  out.z = Math.sin(phi);
  return out;
}

const finitePoint = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon);

/** Inward-facing screen planes through the eye and each adjacent pair of ground hits. */
function footprintPlanes(corners, eye, heightM) {
  if (
    !Number.isFinite(heightM) ||
    heightM <= 0 ||
    !finitePoint(eye) ||
    corners?.length !== 4 ||
    !corners.every(finitePoint)
  )
    return null;
  const position = (at, altitudeM = 0) =>
    scale(unitVector(at.lat, at.lon), EARTH_RADIUS_KM + altitudeM / 1000);
  const camera = position(eye, heightM);
  const hits = corners.map((at) => position(at));
  const rays = hits.map((hit) => sub(hit, camera));
  const middle = scale(rays.reduce(add), 0.25);
  const normals = [];
  for (let i = 0; i < rays.length; i++) {
    // A sampled side ray preserves its side plane. The horizon bounds the open top.
    if (i === 3 && (corners[0].edge || corners[3].edge)) continue;
    const normal = cross(rays[i], rays[(i + 1) % rays.length]);
    const orientation = Math.sign(dot(normal, middle));
    if (!orientation) return null;
    normals.push(scale(normal, orientation / magnitude(normal)));
  }
  return { camera, hits, normals };
}

export function footprintTest(corners, eye, heightM) {
  const footprint = footprintPlanes(corners, eye, heightM);
  if (!footprint) return null;
  const { camera, normals } = footprint;
  const ray = { x: 0, y: 0, z: 0 };
  return (at, altitudeM = 0) => {
    const elevation =
      Number.isFinite(altitudeM) && altitudeM > 0 ? altitudeM : 0;
    const radius = EARTH_RADIUS_KM + elevation / 1000;
    unitVector(at.lat, at.lon, ray);
    ray.x = ray.x * radius - camera.x;
    ray.y = ray.y * radius - camera.y;
    ray.z = ray.z * radius - camera.z;
    const tolerance = -1e-9 * magnitude(ray);
    for (let i = 0; i < normals.length; i++) {
      if (!(dot(normals[i], ray) >= tolerance)) return false;
    }
    return true;
  };
}

// Screen edges are planes through the eye. Along the chord between two
// ground points, each plane cuts a linear interval. The actual trail follows
// interpolated latitude/longitude on the sphere: bound its departure from
// the chord before discarding any interval.
export function groundLineCrossing(corners, eye, heightM) {
  if (corners?.length !== 4) return null;
  let planes;
  return (place, start, end, radians, visible) => {
    // Most queries contain only points or already have a visible anchor.
    if (planes === undefined) {
      const footprint = footprintPlanes(corners, eye, heightM);
      planes =
        footprint?.normals.map((normal) => ({
          normal,
          offset: dot(normal, footprint.camera) / EARTH_RADIUS_KM,
        })) ?? null;
    }
    if (!planes) return null;
    for (let step = 0; step < 12 && end > start; step++) {
      const a = place(start);
      const b = place(end);
      const u = unitVector(a.lat, a.lon);
      const v = unitVector(b.lat, b.lon);
      // The norm of the second derivative of the unit vector is at most
      // (|delta latitude| + |delta longitude|)^2 on this interval.
      const error = ((end - start) * radians) ** 2 / 8 + 1e-12;
      let lo = 0;
      let hi = 1;
      for (const { normal, offset } of planes) {
        const from = dot(normal, u) - offset + error;
        const to = dot(normal, v) - offset + error;
        if (from < 0 && to < 0) return null;
        if (from < 0) lo = Math.max(lo, from / (from - to));
        if (to < 0) hi = Math.min(hi, from / (from - to));
      }
      if (lo > hi) return null;
      const span = end - start;
      end = start + hi * span;
      start += lo * span;
      const mid = (start + end) / 2;
      if (visible(place(mid))) return mid;
      if (lo === 0 && hi === 1) return null;
    }
    return null;
  };
}

/** Ground distance to the footprint, including its curved edges on the sphere. */
export function footprintGroundDistance(corners, eye, heightM) {
  if (corners?.some((corner) => corner?.edge)) return null;
  const footprint = footprintPlanes(corners, eye, heightM);
  if (!footprint) return null;
  const vertices = footprint.hits.map((hit) => scale(hit, 1 / EARTH_RADIUS_KM));
  const edges = footprint.normals.map((normal) => {
    const offset = dot(normal, footprint.camera) / EARTH_RADIUS_KM;
    return {
      normal,
      offset,
      radius: Math.sqrt(Math.max(0, 1 - offset * offset)),
    };
  });
  const contains = (point) =>
    edges.every(({ normal, offset }) => dot(normal, point) >= offset - 1e-12);
  return (at) => {
    const point = at.x === undefined ? unitVector(at.lat, at.lon) : at;
    if (contains(point)) return 0;
    let nearest = Math.max(...vertices.map((vertex) => dot(point, vertex)));
    for (const { normal, offset, radius } of edges) {
      // The nearest point on the plane's circle is its tangential projection;
      // an overrun falls back to the relevant corner.
      const tangent = sub(point, scale(normal, dot(normal, point)));
      const length = magnitude(tangent);
      if (length < 1e-12) continue;
      const projected = add(
        scale(normal, offset),
        scale(tangent, radius / length),
      );
      if (contains(projected))
        nearest = Math.max(nearest, dot(point, projected));
    }
    return EARTH_RADIUS_KM * acosClamped(nearest);
  };
}

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

/** Find a nearby GeoJSON line anchor using spherical distances to its drawn path. */
export function linePointWithinRadius(paths, center, radiusKm) {
  // One degree of latitude is at least about 110 km.
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

/** Segment intervals inside the rectangle, unwrapped across the date line. */
function* segmentIntervals(paths, rect, south, north) {
  const west = rect?.west;
  const east = rect && (rect.east < west ? rect.east + 360 : rect.east);
  if (rect && ![west, east, south, north].every(Number.isFinite)) return;
  for (const { bounds, points } of paths) {
    if (bounds.north < south || bounds.south > north) continue;
    if (rect) {
      const shift = 360 * Math.ceil((bounds.west - east) / 360);
      if (west + shift > bounds.east) continue;
    }
    const path = points();
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      if (Math.max(a.lat, b.lat) < south || Math.min(a.lat, b.lat) > north)
        continue;
      const dy = b.lat - a.lat;
      const dx = longitudeDelta(b.lon - a.lon);
      if (!rect) {
        yield { a, dx, dy, start: 0, end: 1 };
        continue;
      }
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
        if (start <= end) yield { a, dx, dy, start, end, alongLon, toLon };
      }
    }
  }
}

function clippedLongitude(lon, rect) {
  const wrapped = longitudeDelta(lon);
  if (wrapped === 180 && rect?.west === -180 && rect.east < 180) return -180;
  if (wrapped === -180 && rect?.east === 180 && rect.west > -180) return 180;
  return wrapped;
}

const VISIBLE_SAMPLES = 16;
const VISIBLE_BISECTIONS = 12;

/**
 * Closest point to the view centre on the part of a drawn path inside the
 * rectangle. Paths use the renderer's rhumb vertices in degrees. Clip each
 * segment in its own unwrapped longitude interval across the date line.
 * Keep only points `visible` accepts (the screen footprint).
 */
export function linePointInRect(
  paths,
  rect,
  center,
  spherical = false,
  visible = null,
  crossing = null,
) {
  if (!paths) return null;
  const lonWeight = Math.cos((center.lat * Math.PI) / 180) ** 2;
  let best = null;
  let bestKm = Infinity;
  for (const { a, dx, dy, start, end, alongLon, toLon } of segmentIntervals(
    paths,
    rect,
    rect.south,
    rect.north,
  )) {
    const place = (fraction) => ({
      lat: Math.max(rect.south, Math.min(rect.north, a.lat + fraction * dy)),
      lon:
        dx && fraction === alongLon
          ? rect.west
          : dx && fraction === toLon
            ? rect.east
            : clippedLongitude(a.lon + fraction * dx, rect),
    });
    let t;
    if (spherical) {
      const from = place(start);
      const to = place(end);
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
        (fraction) => greatCircleKm(center, place(fraction)),
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
    let at = place(t);
    if (visible && !visible(at)) {
      let inside = null;
      let nearestKm = Infinity;
      for (let i = 0; i <= VISIBLE_SAMPLES; i++) {
        const f = start + ((end - start) * i) / VISIBLE_SAMPLES;
        const sample = place(f);
        if (!visible(sample)) continue;
        const km = greatCircleKm(center, sample);
        if (km < nearestKm) {
          nearestKm = km;
          inside = f;
        }
      }
      if (inside === null && crossing)
        inside = crossing(
          place,
          start,
          end,
          ((Math.abs(dx) + Math.abs(dy)) * Math.PI) / 180,
          visible,
        );
      if (inside === null) continue;
      let outside = t;
      for (let i = 0; i < VISIBLE_BISECTIONS; i++) {
        const mid = (inside + outside) / 2;
        if (visible(place(mid))) inside = mid;
        else outside = mid;
      }
      at = place(inside);
    }
    const km = greatCircleKm(center, at);
    if (km < bestKm) {
      best = at;
      bestKm = km;
    }
  }
  return best;
}

/** Find the nearest rendered line point on the camera's visible ground cap. */
export function linePointInCap(
  paths,
  center,
  eye,
  radiusKm,
  scoreInView,
  rect = null,
) {
  const latitudeSpan = radiusKm / 110;
  const south = Math.max(eye.lat - latitudeSpan, rect?.south ?? -90);
  const north = Math.min(eye.lat + latitudeSpan, rect?.north ?? 90);
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
  for (const { a, dx, dy, start: low, end: high } of segmentIntervals(
    paths,
    rect,
    south,
    north,
  )) {
    const at = (t) => ({
      lat: a.lat + t * dy,
      lon: clippedLongitude(a.lon + t * dx, rect),
    });
    const span = high - low;
    const pieces = longitudePieces(dx * span);
    for (let j = 0; j < pieces; j++) {
      const start = low + (j / pieces) * span;
      const end = j + 1 === pieces ? high : low + ((j + 1) / pieces) * span;
      const from = at(start);
      const to = at(end);
      const fromVisible = consider(from) !== -Infinity;
      const toVisible = consider(to) !== -Infinity;
      const maxSegmentKm = segmentLengthBound(
        from.lat,
        to.lat,
        dx * (end - start),
      );
      if (
        !maxSegmentKm ||
        greatCircleKm(center, from) + greatCircleKm(center, to) - maxSegmentKm >
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
  return best;
}
