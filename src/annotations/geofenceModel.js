/**
 * Geofence model: the pure half of the click-to-draw closed polygon tool.
 *
 * A geofence is a single closed geospatial polygon (a ring of lon/lat).
 * This module holds no Cesium and no DOM so it is importable under node --test.
 * The Cesium/DOM half is `geofenceTool.js` + `geofenceRenderer.js`.
 *
 * Contract:
 * - A session is { vertices: Array<{lon,lat}> } — an OPEN ring while drawing.
 * - A finished geofence is valid when it has >=3 vertices and encloses area.
 * - Editing mutates vertices in place: move, remove, insert, clear.
 * - closeRing() returns a CLOSED ring (first == last) for rendering/GeoJSON.
 */

export const MIN_VERTICES = 3;
export const MAX_VERTICES = 512;
export const MIN_VERTEX_SEPARATION_M = 0.5;
export const MIN_AREA_M2 = 1;

export function createGeofenceSession() {
  return { vertices: [] };
}

export function isFiniteLonLat(v) {
  if (!v) return false;
  const { lon, lat } = v;
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    Math.abs(lon) <= 180 &&
    Math.abs(lat) <= 90
  );
}

export function greatCircleM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
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

export function wrapLongitude(lon) {
  if (!Number.isFinite(lon)) return lon;
  if (lon >= -180 && lon < 180) return lon;
  const v = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Object.is(v, -0) ? 0 : v;
}

export function ringAreaM2(vertices) {
  if (!vertices || vertices.length < 3) return 0;
  const ring = unwrapLongitudes(vertices);
  const lat0 = ring.reduce((s, v) => s + v.lat, 0) / ring.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111320;
  let twice = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    twice += a.lon * kx * (b.lat * ky) - b.lon * kx * (a.lat * ky);
  }
  return Math.abs(twice) / 2;
}

export function addVertex(
  session,
  vertex,
  { minSeparationM = MIN_VERTEX_SEPARATION_M } = {},
) {
  if (!session || !isFiniteLonLat(vertex))
    return { added: false, reason: 'invalid' };
  const v = { lon: vertex.lon, lat: vertex.lat };
  if (session.vertices.length >= MAX_VERTICES)
    return { added: false, reason: 'full' };
  const last = session.vertices[session.vertices.length - 1];
  if (last && greatCircleM(last, v) < minSeparationM)
    return { added: false, reason: 'duplicate' };
  session.vertices.push(v);
  return { added: true };
}

export function removeLastVertex(session) {
  if (!session?.vertices?.length) return false;
  session.vertices.pop();
  return true;
}

export function moveVertex(session, index, lonLat) {
  if (!session || !isFiniteLonLat(lonLat)) return false;
  if (!Number.isInteger(index) || index < 0 || index >= session.vertices.length)
    return false;
  session.vertices[index] = { lon: lonLat.lon, lat: lonLat.lat };
  return true;
}

export function removeVertex(session, index) {
  if (!session || !Number.isInteger(index)) return false;
  if (index < 0 || index >= session.vertices.length) return false;
  session.vertices.splice(index, 1);
  return true;
}

export function insertVertex(session, index, lonLat) {
  if (!session || !isFiniteLonLat(lonLat)) return false;
  if (session.vertices.length >= MAX_VERTICES) return false;
  const at = Math.max(0, Math.min(session.vertices.length, index));
  session.vertices.splice(at, 0, { lon: lonLat.lon, lat: lonLat.lat });
  return true;
}

export function clearSession(session) {
  if (!session) return false;
  session.vertices.length = 0;
  return true;
}

export function finishReason(session) {
  if (!session || !Array.isArray(session.vertices)) return 'invalid';
  if (session.vertices.some((v) => !isFiniteLonLat(v))) return 'invalid';
  if (session.vertices.length < MIN_VERTICES) return 'too-few';
  if (ringAreaM2(session.vertices) < MIN_AREA_M2) return 'degenerate';
  return 'ok';
}

export function canFinish(session) {
  return finishReason(session) === 'ok';
}

export function closeRing(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 3) return pairs;
  const [fl, ft] = pairs[0];
  const [ll, lt] = pairs[pairs.length - 1];
  if (fl === ll && ft === lt) return pairs;
  return [...pairs, [fl, ft]];
}

export function toClosedLonLat(session) {
  const pts = session.vertices.map((v) => [v.lon, v.lat]);
  return closeRing(pts);
}

export function toGeoJSON(session, { properties = {} } = {}) {
  if (!canFinish(session)) return null;
  return {
    type: 'Feature',
    properties: { ...properties, kind: 'geofence' },
    geometry: {
      type: 'Polygon',
      coordinates: [toClosedLonLat(session)],
    },
  };
}

export function fromGeoJSON(feature) {
  const coords = feature?.geometry?.coordinates?.[0];
  if (!Array.isArray(coords) || coords.length < 4) return null;
  const vertices = [];
  for (let i = 0; i < coords.length - 1; i += 1) {
    const [lon, lat] = coords[i];
    if (!isFiniteLonLat({ lon, lat })) return null;
    vertices.push({ lon, lat });
  }
  const session = createGeofenceSession();
  session.vertices = vertices;
  return canFinish(session) ? session : null;
}

export function geofenceHint(session, { hasGeofence = false } = {}) {
  if (!session) return 'Press Geofence to start drawing.';
  const n = session.vertices.length;
  if (n === 0)
    return hasGeofence
      ? 'Geofence active — Edit to move vertices, Clear to remove.'
      : 'Click on the globe to add points.';
  const need = MIN_VERTICES - n;
  if (need > 0) return `Click ${need} more point${need === 1 ? '' : 's'} to close.`;
  if (finishReason(session) === 'degenerate')
    return 'Those points are in a line — move one off it to enclose an area.';
  return `${formatArea(session)} · double-click or Finish to close, Backspace undoes, Esc cancels.`;
}

export function formatArea(session) {
  const m2 = ringAreaM2(session.vertices);
  if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(2)} km²`;
  if (m2 >= 1e4) return `${(m2 / 1e4).toFixed(1)} ha`;
  return `${Math.round(m2)} m²`;
}
