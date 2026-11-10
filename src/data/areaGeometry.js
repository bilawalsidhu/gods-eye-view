/**
 * Area geometry for voice area handles: normalization, containment, size and
 * display simplification over full MultiPolygons (islands and holes kept).
 *
 * Coordinates follow GeoJSON: a MultiPolygon is `Array<Polygon>`, a Polygon is
 * `Array<Ring>` with the outer ring first and holes after it, a Ring is
 * `Array<[lon, lat]>`.
 *
 * Counting uses the geometry exactly as resolved. Display simplification
 * (`displayParts`) makes a separate copy for drawing and never feeds back into
 * containment.
 *
 * Antimeridian: a ring whose consecutive longitudes jump by more than 180° is
 * unwrapped into one continuous span (e.g. 170..190) when the jumps cancel
 * out. Containment then tests the point at lon, lon + 360 and lon − 360. A ring
 * that circles a pole (jumps that do not cancel) is used as given.
 *
 * Pure: no Cesium, DOM or network.
 * @module data/areaGeometry
 */

const EARTH_RADIUS_KM = 6371;
const toRad = (degrees) => (degrees * Math.PI) / 180;

const validPair = (p) =>
  Array.isArray(p) &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 540 &&
  Math.abs(p[1]) <= 90;

const samePoint = (a, b, eps = 1e-9) =>
  Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;

/** A ring as closed [lon, lat] pairs, or null with fewer than 3 distinct points. */
function cleanRing(ring) {
  if (!Array.isArray(ring)) return null;
  const out = [];
  for (const p of ring) {
    if (!validPair(p)) continue;
    const pair = [Number(p[0]), Number(p[1])];
    if (out.length && samePoint(out[out.length - 1], pair)) continue;
    out.push(pair);
  }
  if (out.length && samePoint(out[0], out[out.length - 1])) out.pop();
  if (out.length < 3) return null;
  out.push([out[0][0], out[0][1]]);
  return out;
}

/**
 * GeoJSON Polygon/MultiPolygon geometry (or bare coordinates) → MultiPolygon
 * coordinates with closed rings; null when nothing usable remains. Degenerate
 * holes are dropped; a polygon whose outer ring is degenerate is dropped whole.
 * @param {object|Array} geometry
 * @returns {Array|null}
 */
export function normalizeMultiPolygon(geometry) {
  let polygons;
  if (Array.isArray(geometry)) {
    // Bare coordinates: a ring, a polygon or a multipolygon, by nesting depth.
    const depth = (value) => (Array.isArray(value) ? 1 + depth(value[0]) : 0);
    const d = depth(geometry);
    polygons = d === 2 ? [[geometry]] : d === 3 ? [geometry] : geometry;
  } else if (geometry?.type === 'Polygon') polygons = [geometry.coordinates];
  else if (geometry?.type === 'MultiPolygon') polygons = geometry.coordinates;
  else return null;
  const out = [];
  for (const polygon of Array.isArray(polygons) ? polygons : []) {
    if (!Array.isArray(polygon)) continue;
    const outer = cleanRing(polygon[0]);
    if (!outer) continue;
    const holes = polygon.slice(1).map(cleanRing).filter(Boolean);
    out.push([outer, ...holes]);
  }
  return out.length ? out : null;
}

/**
 * Longitudes made continuous across the antimeridian. Returns the ring as
 * given when it has no jump, or when its jumps do not cancel (a ring that
 * circles a pole).
 */
export function unwrapRing(ring) {
  let shift = 0;
  let jumped = false;
  const out = [[ring[0][0], ring[0][1]]];
  for (let i = 1; i < ring.length; i += 1) {
    const delta = ring[i][0] - ring[i - 1][0];
    if (delta > 180) {
      shift -= 360;
      jumped = true;
    } else if (delta < -180) {
      shift += 360;
      jumped = true;
    }
    out.push([ring[i][0] + shift, ring[i][1]]);
  }
  if (!jumped) return ring;
  return shift === 0 ? out : ring;
}

function ringBbox(ring) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

/** Even-odd ray cast. */
function pointInRingXY(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

const wrap180 = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
const wrap360 = (lon) => {
  const wrapped = lon % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
};

/** The shortest circular longitude interval containing every outer-ring vertex. */
function longitudeEnvelope(parts) {
  const values = parts
    .flatMap(({ outer }) => outer.map(([lon]) => wrap360(lon)))
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  let gapIndex = values.length - 1;
  let largestGap = values[0] + 360 - values.at(-1);
  for (let i = 0; i < values.length - 1; i += 1) {
    const gap = values[i + 1] - values[i];
    if (gap > largestGap) {
      largestGap = gap;
      gapIndex = i;
    }
  }
  const start = values[(gapIndex + 1) % values.length];
  let end = values[gapIndex];
  if (end < start) end += 360;
  const span = end - start;
  if (span >= 360 - 1e-9) return { west: -180, east: 180, crosses: false };
  const west = start > 180 ? start - 360 : start;
  const endOnCircle = end >= 360 ? end - 360 : end;
  const east = endOnCircle > 180 ? endOnCircle - 360 : endOnCircle;
  return { west, east, crosses: west > east };
}

/**
 * Index a MultiPolygon for repeated containment tests: unwrapped rings with
 * per-part bounding boxes, plus the overall bbox as [west, south, east, north]
 * in −180..180 (west > east when it crosses the antimeridian).
 * @param {Array} coordinates MultiPolygon coordinates.
 * @returns {{parts: Array, bbox: number[], vertexCount: number, crossesAntimeridian: boolean}|null}
 */
export function prepareArea(coordinates) {
  const multi = normalizeMultiPolygon(coordinates);
  if (!multi) return null;
  let vertexCount = 0;
  let crosses = false;
  const parts = multi.map((polygon) => {
    const outer = unwrapRing(polygon[0]);
    if (outer !== polygon[0]) crosses = true;
    const holes = polygon.slice(1).map((ring) => {
      let hole = unwrapRing(ring);
      // Keep a hole in the same longitude frame as its outer ring.
      const hb = ringBbox(hole);
      const ob = ringBbox(outer);
      const mid = (hb[0] + hb[2]) / 2;
      if (mid < ob[0]) hole = hole.map(([x, y]) => [x + 360, y]);
      else if (mid > ob[2]) hole = hole.map(([x, y]) => [x - 360, y]);
      return hole;
    });
    for (const ring of polygon) vertexCount += ring.length;
    return { outer, holes, bbox: ringBbox(outer) };
  });
  let south = Infinity;
  let north = -Infinity;
  for (const { bbox } of parts) {
    south = Math.min(south, bbox[1]);
    north = Math.max(north, bbox[3]);
  }
  const envelope = longitudeEnvelope(parts);
  const bbox = [envelope.west, south, envelope.east, north];
  crosses ||= envelope.crosses;
  return { parts, bbox, vertexCount, crossesAntimeridian: crosses };
}

function inPart(part, lon, lat) {
  const [w, s, e, n] = part.bbox;
  if (lat < s || lat > n || lon < w || lon > e) return false;
  if (!pointInRingXY(part.outer, lon, lat)) return false;
  for (const hole of part.holes)
    if (pointInRingXY(hole, lon, lat)) return false;
  return true;
}

/**
 * Whether a point lies inside the area: inside some part's outer ring and in
 * none of that part's holes. Points exactly on an edge follow the ray-cast
 * convention and may land either side.
 * @param {object} prepared From prepareArea.
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function pointInPreparedArea(prepared, lat, lon) {
  if (!prepared || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  for (const part of prepared.parts) {
    if (inPart(part, lon, lat)) return true;
    if (inPart(part, lon + 360, lat)) return true;
    if (inPart(part, lon - 360, lat)) return true;
  }
  return false;
}

/** Spherical-excess ring area in km² (unsigned). */
export function ringAreaKm2(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n - 1; i += 1) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    sum +=
      toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

/**
 * Area of a MultiPolygon in km², holes subtracted.
 * @param {Array} coordinates
 * @returns {number}
 */
export function multiPolygonAreaKm2(coordinates) {
  const multi = normalizeMultiPolygon(coordinates);
  if (!multi) return 0;
  let total = 0;
  for (const polygon of multi) {
    total += ringAreaKm2(unwrapRing(polygon[0]));
    for (const hole of polygon.slice(1)) total -= ringAreaKm2(unwrapRing(hole));
  }
  return Math.max(0, total);
}

/** Counts of parts and holes. */
export function multiPolygonCounts(coordinates) {
  const multi = normalizeMultiPolygon(coordinates) || [];
  return {
    parts: multi.length,
    holes: multi.reduce((sum, polygon) => sum + polygon.length - 1, 0),
  };
}

/** Mean of the largest part's outer ring vertices, wrapped to −180..180. */
export function areaAnchor(coordinates) {
  const multi = normalizeMultiPolygon(coordinates);
  if (!multi) return null;
  let best = null;
  let bestArea = -1;
  for (const polygon of multi) {
    const ring = unwrapRing(polygon[0]);
    const area = ringAreaKm2(ring);
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  }
  let lon = 0;
  let lat = 0;
  const pts = best.slice(0, -1);
  for (const [x, y] of pts) {
    lon += x;
    lat += y;
  }
  return { lon: wrap180(lon / pts.length), lat: lat / pts.length };
}

// ── Display copies ────────────────────────────────────────────

function dpRing(ring, tol) {
  const n = ring.length;
  if (n <= 5) return ring;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay] = ring[a];
    const vx = ring[b][0] - ax;
    const vy = ring[b][1] - ay;
    const c2 = vx * vx + vy * vy;
    let worst = -1;
    let worstD = tol;
    for (let i = a + 1; i < b; i += 1) {
      const wx = ring[i][0] - ax;
      const wy = ring[i][1] - ay;
      const t =
        c2 === 0 ? 0 : Math.max(0, Math.min(1, (vx * wx + vy * wy) / c2));
      const d = Math.hypot(wx - t * vx, wy - t * vy);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i += 1) if (keep[i]) out.push(ring[i]);
  return out.length >= 4 ? out : ring;
}

/**
 * A simplified copy of the area for drawing only: the largest `maxParts`
 * parts, each ring Douglas-Peucker simplified until the whole copy fits in
 * `maxVertices`. Rings keep their antimeridian-unwrapped longitudes so a
 * crossing part draws as one shape.
 * @param {Array} coordinates MultiPolygon coordinates.
 * @param {{maxVertices?: number, maxParts?: number}} [options]
 * @returns {{parts: Array<{outer: Array, holes: Array}>, drawnParts: number, totalParts: number}}
 */
export function displayParts(
  coordinates,
  { maxVertices = 6000, maxParts = 40 } = {},
) {
  const multi = normalizeMultiPolygon(coordinates) || [];
  const ranked = multi
    .map((polygon) => ({
      rings: polygon.map((ring) => unwrapRing(ring)),
      area: ringAreaKm2(unwrapRing(polygon[0])),
    }))
    .sort((a, b) => b.area - a.area)
    .slice(0, maxParts);
  const bbox = ranked.length ? ringBbox(ranked[0].rings[0]) : [0, 0, 0, 0];
  let tol = Math.max(
    1e-6,
    Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) / 1500,
  );
  let parts = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    parts = ranked.map(({ rings }) => ({
      outer: dpRing(rings[0], tol),
      holes: rings.slice(1).map((ring) => dpRing(ring, tol)),
    }));
    const total = parts.reduce(
      (sum, p) =>
        sum + p.outer.length + p.holes.reduce((h, r) => h + r.length, 0),
      0,
    );
    if (total <= maxVertices) break;
    tol *= 2;
  }
  return { parts, drawnParts: parts.length, totalParts: multi.length };
}

/**
 * A circle as a closed ring (planar metres around the centre — accurate for
 * the few-kilometre buffers it is used for).
 * @returns {Array<[number, number]>}
 */
export function circleRing(lat, lon, radiusM, segments = 48) {
  const mPerDegLat = 111_320;
  const mPerDegLon = mPerDegLat * Math.max(0.01, Math.cos(toRad(lat)));
  const ring = [];
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    ring.push([
      lon + (Math.cos(a) * radiusM) / mPerDegLon,
      lat + (Math.sin(a) * radiusM) / mPerDegLat,
    ]);
  }
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}
