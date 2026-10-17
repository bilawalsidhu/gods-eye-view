// ── geometry ────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

/** Spherical ring area (km²); matches src/data/naturalEarthRegions.js. */
function ringAreaKm2(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % n];
    sum +=
      toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

/** Signed planar (shoelace) area: positive counter-clockwise in lon/lat. */
function signedArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return sum / 2;
}

function segDist(p, a, b) {
  let [x, y] = p;
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx !== 0 || dy !== 0) {
    const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x -= x2;
      y -= y2;
      return Math.hypot(x, y);
    }
    if (t > 0) {
      x -= x1 + dx * t;
      y -= y1 + dy * t;
      return Math.hypot(x, y);
    }
  }
  return Math.hypot(x - x1, y - y1);
}

/** Iterative Douglas-Peucker over an open point list. */
function douglasPeucker(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segDist(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > tolerance && index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Simplify a closed ring to an OPEN rounded ring. The ring is split at its
 * farthest vertex from the start so Douglas-Peucker has two anchored halves
 * (a closed ring has no chord to measure against). Returns null when fewer
 * than four distinct vertices survive.
 */
function simplifyRing(ring, tolerance, decimals) {
  let open = ring.slice();
  const first = open[0];
  const last = open[open.length - 1];
  if (open.length > 1 && first[0] === last[0] && first[1] === last[1])
    open = open.slice(0, -1);
  if (open.length < 4) return null;
  let far = 1;
  let farDist = -1;
  for (let i = 1; i < open.length; i++) {
    const d = Math.hypot(open[i][0] - first[0], open[i][1] - first[1]);
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }
  const a = douglasPeucker(open.slice(0, far + 1), tolerance);
  const b = douglasPeucker([...open.slice(far), first], tolerance);
  const simplified = [...a, ...b.slice(1, -1)];
  const factor = 10 ** decimals;
  const out = [];
  for (const [lon, lat] of simplified) {
    const p = [
      Math.round(lon * factor) / factor,
      Math.round(lat * factor) / factor,
    ];
    const prev = out[out.length - 1];
    if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
    out.push(p);
  }
  while (
    out.length > 1 &&
    out[0][0] === out[out.length - 1][0] &&
    out[0][1] === out[out.length - 1][1]
  )
    out.pop();
  return out.length >= 4 ? out : null;
}

/**
 * Simplify polygons ([outer, ...holes][]): drop parts and holes under the
 * area floors (the largest part always stays), orient outers
 * counter-clockwise and holes clockwise, sort parts by area descending.
 */
function simplifyPolygons(polygons, params, tolerance, decimals) {
  const parts = [];
  for (const poly of polygons) {
    const outer = simplifyRing(poly[0], tolerance, decimals);
    if (!outer) continue;
    const area = ringAreaKm2(outer);
    if (signedArea(outer) < 0) outer.reverse();
    const holes = [];
    for (const hole of poly.slice(1)) {
      const ring = simplifyRing(hole, tolerance, decimals);
      if (!ring || ringAreaKm2(ring) < params.minHoleKm2) continue;
      if (signedArea(ring) > 0) ring.reverse();
      holes.push(ring);
    }
    parts.push({ rings: [outer, ...holes], area });
  }
  parts.sort((x, y) => y.area - x.area);
  const floor = Math.max(
    params.minPartKm2,
    (parts[0]?.area || 0) * params.minPartShare,
  );
  return parts
    .filter((part, index) => index === 0 || part.area >= floor)
    .map((part) => part.rings);
}

/**
 * Simplify one unit at its size-scaled tolerance. A unit too small to
 * survive the pack precision (a Maldives atoll) is kept at one more decimal
 * and a fifth of the minimum tolerance, or failing that unsimplified at two
 * more decimals; the caller records `d`.
 */
function simplifyUnit(polygons, params) {
  const sourceArea = polygons.reduce(
    (sum, poly) => sum + ringAreaKm2(poly[0]),
    0,
  );
  const tolerance = Math.min(
    params.maxToleranceDeg,
    Math.max(
      params.minToleranceDeg,
      (params.toleranceFactor * Math.sqrt(sourceArea)) / 111.32,
    ),
  );
  const coarse = simplifyPolygons(polygons, params, tolerance, params.decimals);
  if (coarse.length) return { polygons: coarse, decimals: params.decimals };
  const fine = simplifyPolygons(
    polygons,
    params,
    params.minToleranceDeg / 5,
    params.decimals + 1,
  );
  if (fine.length) return { polygons: fine, decimals: params.decimals + 1 };
  // Smaller still (Vatican City): the source ring as drawn.
  const exact = simplifyPolygons(polygons, params, 0, params.decimals + 2);
  return { polygons: exact, decimals: params.decimals + 2 };
}

/**
 * Encode a rounded open ring as integers in units of 10^-decimals degrees:
 * the first vertex absolute, every later vertex as a delta from the previous
 * one — [lon0, lat0, dLon1, dLat1, …]. Decoded by `decodeRing` in
 * src/data/adminBoundaries.js.
 */
function encodeRing(ring, decimals) {
  const factor = 10 ** decimals;
  const out = [];
  let px = 0;
  let py = 0;
  for (const [lon, lat] of ring) {
    const x = Math.round(lon * factor);
    const y = Math.round(lat * factor);
    out.push(x - px, y - py);
    px = x;
    py = y;
  }
  return out;
}

function encodeUnit({ polygons, decimals }) {
  return polygons.map((poly) => poly.map((ring) => encodeRing(ring, decimals)));
}

function geojsonPolygons(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function bboxOf(polygons) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const poly of polygons)
    for (const [lon, lat] of poly[0]) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  return [w, s, e, n];
}

export {
  ringAreaKm2,
  signedArea,
  simplifyUnit,
  encodeUnit,
  geojsonPolygons,
  bboxOf,
};
