/**
 * Manual whiteboard drawing: the pure half.
 *
 * The voice whiteboard resolves NAMES to geometry. This module is for the other
 * way in: a person clicks the vertices themselves. It holds a draw session (the
 * shape being drawn and its vertices), decides when a shape is finishable, and
 * turns a finished session into the SAME annotation spec the engine already
 * accepts (`type: area | route | pin`, geometry supplied, `manual: true`), so a
 * hand-drawn mark renders, persists, de-dups, exports to GeoJSON, and clears
 * exactly like a spoken one.
 *
 * No Cesium, no DOM — importable under `node --test`. The Cesium/DOM half is
 * `drawTool.js`.
 */

export const DRAW_SHAPES = Object.freeze(['area', 'line', 'pin']);
export const MIN_VERTICES = Object.freeze({ area: 3, line: 2, pin: 1 });
/** Two clicks closer than this are one vertex: a double-click to finish must not add a stray point. */
export const MIN_VERTEX_SEPARATION_M = 0.5;

let drawModeActive = false;

/** Whether a manual draw session owns scene clicks right now (read by click gestures). */
export function isDrawModeActive() {
  return drawModeActive;
}

/** @param {boolean} active */
export function setDrawModeActive(active) {
  drawModeActive = Boolean(active);
  return drawModeActive;
}

/** @param {string} shape @returns {'area'|'line'|'pin'} */
export function normalizeShape(shape) {
  const s = String(shape || '').toLowerCase();
  if (s === 'line' || s === 'path' || s === 'route') return 'line';
  if (s === 'pin' || s === 'point' || s === 'marker') return 'pin';
  return 'area';
}

/** @param {string} [shape] @returns {{shape: 'area'|'line'|'pin', vertices: Array<{lon:number, lat:number, height?:number}>}} */
export function createDrawSession(shape = 'area') {
  return { shape: normalizeShape(shape), vertices: [] };
}

/** Great-circle distance in metres between two {lon, lat} points. */
export function greatCircleM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
}

/**
 * Add a vertex. A vertex that is not a finite lon/lat is refused; one within
 * MIN_VERTEX_SEPARATION_M of the previous vertex is treated as the same click
 * (the second half of a double-click) and refused as a duplicate. A pin holds
 * exactly one vertex: a later click moves it.
 * @returns {{added: boolean, reason?: 'invalid'|'duplicate'}}
 */
export function addVertex(session, vertex, { minSeparationM = MIN_VERTEX_SEPARATION_M } = {}) {
  if (!session || !vertex || !Number.isFinite(vertex.lon) || !Number.isFinite(vertex.lat)) {
    return { added: false, reason: 'invalid' };
  }
  const v = { lon: vertex.lon, lat: vertex.lat, height: Number.isFinite(vertex.height) ? vertex.height : 0 };
  if (session.shape === 'pin') {
    session.vertices = [v];
    return { added: true };
  }
  const last = session.vertices[session.vertices.length - 1];
  if (last && greatCircleM(last, v) < minSeparationM) return { added: false, reason: 'duplicate' };
  session.vertices.push(v);
  return { added: true };
}

/** Remove the last vertex. @returns {boolean} whether one was removed */
export function removeLastVertex(session) {
  if (!session?.vertices?.length) return false;
  session.vertices.pop();
  return true;
}

/** @returns {boolean} whether the session has enough vertices to become an annotation */
export function canFinish(session) {
  if (!session) return false;
  return session.vertices.length >= (MIN_VERTICES[session.shape] || 1);
}

/** Length of an open path in metres. */
export function pathLengthM(vertices) {
  let m = 0;
  for (let i = 1; i < (vertices?.length || 0); i += 1) m += greatCircleM(vertices[i - 1], vertices[i]);
  return m;
}

/** Planar shoelace area of a ring in square metres (local metre grid; fine at whiteboard scale). */
export function ringAreaM2(vertices) {
  if (!vertices || vertices.length < 3) return 0;
  const lat0 = vertices.reduce((s, v) => s + v.lat, 0) / vertices.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111320;
  let twice = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    twice += (a.lon * kx) * (b.lat * ky) - (b.lon * kx) * (a.lat * ky);
  }
  return Math.abs(twice) / 2;
}

/** Vertex-average centroid of a ring, {lon, lat}. */
export function ringCentroid(vertices) {
  if (!vertices?.length) return null;
  return {
    lon: vertices.reduce((s, v) => s + v.lon, 0) / vertices.length,
    lat: vertices.reduce((s, v) => s + v.lat, 0) / vertices.length,
  };
}

/** Distance or area, formatted for a label suffix. */
export function formatMeasure(session) {
  if (!session) return '';
  if (session.shape === 'line') {
    const m = pathLengthM(session.vertices);
    return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;
  }
  if (session.shape === 'area') {
    const m2 = ringAreaM2(session.vertices);
    if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(2)} km²`;
    if (m2 >= 1e4) return `${(m2 / 1e4).toFixed(1)} ha`;
    return `${Math.round(m2)} m²`;
  }
  return '';
}

/**
 * The annotation spec for a finished session, in the shape `annotationEngine.annotate()`
 * takes. Null when the session cannot finish. Geometry is supplied outright and
 * `manual: true` tells the engine to skip name resolution.
 * @param {object} session
 * @param {{label?: string, color?: string}} [opts]
 */
export function finishSpec(session, { label = '', color = 'primary' } = {}) {
  if (!canFinish(session)) return null;
  const text = String(label || '').trim();
  const pts = session.vertices.map((v) => [v.lon, v.lat]);
  if (session.shape === 'area') {
    return { type: 'area', manual: true, ring: pts, label: text || null, color };
  }
  if (session.shape === 'line') {
    return { type: 'route', manual: true, path: pts, label: text || null, color };
  }
  const [lon, lat] = pts[0];
  return { type: 'pin', manual: true, latitude: lat, longitude: lon, label: text || null, color };
}

/** One line of guidance for the person drawing, by state. */
export function drawHint(session) {
  if (!session) return 'Pick a shape, then click the map.';
  const n = session.vertices.length;
  if (session.shape === 'pin') return n ? 'Enter to place the pin, Esc to cancel.' : 'Click where the pin goes.';
  const need = MIN_VERTICES[session.shape] - n;
  if (need > 0) return `Click ${need} more point${need === 1 ? '' : 's'}.`;
  return `${formatMeasure(session)} · double-click or Enter to finish, Backspace undoes, Esc cancels.`;
}
