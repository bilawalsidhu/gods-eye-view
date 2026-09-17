/**
 * Geofence spatial intersection: point-in-polygon for live entity coordinates.
 *
 * Pure, no Cesium, no DOM — importable under node --test.
 * Uses ray-casting with antimeridian unwrapping (same as geofenceModel).
 * Boundary counts as inside (geofence semantics).
 */

export function normalizeVertices(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return [];
  return polygon.map((v) => {
    if (Array.isArray(v)) return { lon: v[0], lat: v[1] };
    return { lon: v.lon ?? v.longitude ?? v.lng, lat: v.lat ?? v.latitude };
  });
}

export function unwrapLongitudes(vertices) {
  if (!vertices?.length) return [];
  const ref = vertices[0].lon;
  return vertices.map((v) => {
    let lon = v.lon;
    while (lon - ref > 180) lon -= 360;
    while (lon - ref < -180) lon += 360;
    return { ...v, lon };
  });
}

function isFiniteLonLat(lon, lat) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    Math.abs(lon) <= 180 &&
    Math.abs(lat) <= 90
  );
}

// Distance from point to segment in degrees (for boundary check)
function pointToSegmentDist(lon, lat, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((lon - ax) * dx + (lat - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const px = ax + t * dx;
  const py = ay + t * dy;
  return Math.hypot(lon - px, lat - py);
}

export function pointInPolygon(lon, lat, polygon) {
  const verts = normalizeVertices(polygon);
  if (verts.length < 3) return false;
  if (!isFiniteLonLat(lon, lat)) return false;
  if (verts.some((v) => !isFiniteLonLat(v.lon, v.lat))) return false;

  // Unwrap for antimeridian: make polygon continuous, then unwrap point relative to ref
  const unwrapped = unwrapLongitudes(verts);
  let uLon = lon;
  const ref = unwrapped[0].lon;
  while (uLon - ref > 180) uLon -= 360;
  while (uLon - ref < -180) uLon += 360;

  // Boundary check: if within epsilon of any edge, count as inside
  const EPS_DEG = 1e-9;
  for (let i = 0, j = unwrapped.length - 1; i < unwrapped.length; j = i++) {
    const a = unwrapped[j];
    const b = unwrapped[i];
    if (pointToSegmentDist(uLon, lat, a.lon, a.lat, b.lon, b.lat) < EPS_DEG) {
      return true;
    }
  }

  // Ray casting
  let inside = false;
  for (let i = 0, j = unwrapped.length - 1; i < unwrapped.length; j = i++) {
    const xi = unwrapped[i].lon;
    const yi = unwrapped[i].lat;
    const xj = unwrapped[j].lon;
    const yj = unwrapped[j].lat;
    const intersects =
      yi > lat !== yj > lat &&
      uLon < ((xj - xi) * (lat - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function isInsideGeofence(lon, lat, polygon) {
  if (!polygon || polygon.length < 3) return false;
  return pointInPolygon(lon, lat, polygon);
}

function entityLonLat(e) {
  if (!e) return null;
  const lon = e.lon ?? e.longitude ?? e.lng;
  const lat = e.lat ?? e.latitude;
  if (!isFiniteLonLat(lon, lat)) return null;
  return { lon, lat };
}

export function filterInside(entities, polygon) {
  if (!polygon || polygon.length < 3) return [];
  if (!Array.isArray(entities)) return [];
  const out = [];
  for (const e of entities) {
    const ll = entityLonLat(e);
    if (!ll) continue;
    if (pointInPolygon(ll.lon, ll.lat, polygon)) out.push(e);
  }
  return out;
}

export function evaluateBatch(entities, polygon) {
  const inside = [];
  const outside = [];
  if (!Array.isArray(entities)) return { inside, outside };
  if (!polygon || polygon.length < 3) {
    // No active geofence: everything is outside
    for (const e of entities) {
      if (entityLonLat(e)) outside.push(e);
    }
    return { inside, outside };
  }
  for (const e of entities) {
    const ll = entityLonLat(e);
    if (!ll) continue;
    if (pointInPolygon(ll.lon, ll.lat, polygon)) inside.push(e);
    else outside.push(e);
  }
  return { inside, outside };
}
