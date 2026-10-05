/**
 * Manual whiteboard drawing: the pure half.
 *
 * The voice whiteboard resolves NAMES to geometry. This module is for the other
 * way in: a person clicks the vertices themselves. It holds a draw session (the
 * shape being drawn and its vertices), decides when a shape is finishable, and
 * turns a finished session into the SAME annotation spec the engine already
 * accepts (`type: area | route | pin`, geometry supplied, `manual: true`), so a
 * hand-drawn mark renders, persists, de-dups and clears exactly like a spoken
 * one.
 *
 * A vertex is a lon/lat and nothing more. The world renderer drapes every mark
 * onto the photoreal surface (`clampToGround` + `CESIUM_3D_TILE`), so there is
 * no such thing as a vertex at a height here: the height under the click is
 * used for the live preview and is deliberately dropped at finish.
 *
 * No Cesium, no DOM — importable under `node --test`. The Cesium/DOM half is
 * `drawTool.js`.
 */

export const DRAW_SHAPES = Object.freeze(['area', 'line', 'pin']);
export const MIN_VERTICES = Object.freeze({ area: 3, line: 2, pin: 1 });
/**
 * Hard ceiling on vertices in one shape. Every vertex is a live preview entity
 * and a position in the finished geometry, so a stuck mouse button or a script
 * must not be able to grow one shape without limit.
 */
export const MAX_VERTICES = 512;
/** Two clicks closer than this are one vertex: a double-click to finish must not add a stray point. */
export const MIN_VERTEX_SEPARATION_M = 0.5;
/** A line shorter than this, or an area thinner than this, is a mis-click rather than a shape. */
export const MIN_PATH_LENGTH_M = 1;
export const MIN_AREA_M2 = 1;

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
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
}

/**
 * Add a vertex. A vertex that is not a finite lon/lat is refused; one within
 * MIN_VERTEX_SEPARATION_M of the previous vertex is treated as the same click
 * (the second half of a double-click) and refused as a duplicate. A pin holds
 * exactly one vertex: a later click moves it.
 * @returns {{added: boolean, reason?: 'invalid'|'duplicate'}}
 */
export function addVertex(
  session,
  vertex,
  { minSeparationM = MIN_VERTEX_SEPARATION_M } = {},
) {
  if (!session || !isFiniteCoordinate(vertex))
    return { added: false, reason: 'invalid' };
  const v = {
    lon: vertex.lon,
    lat: vertex.lat,
    height: Number.isFinite(vertex.height) ? vertex.height : 0,
  };
  if (session.shape === 'pin') {
    session.vertices = [v];
    return { added: true };
  }
  if (session.vertices.length >= MAX_VERTICES)
    return { added: false, reason: 'full' };
  const last = session.vertices[session.vertices.length - 1];
  if (last && greatCircleM(last, v) < minSeparationM)
    return { added: false, reason: 'duplicate' };
  session.vertices.push(v);
  return { added: true };
}

/** A usable click position: finite, and on the globe rather than past its edges. */
export function isFiniteCoordinate(vertex) {
  if (!vertex) return false;
  const { lon, lat } = vertex;
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    Math.abs(lon) <= 180 &&
    Math.abs(lat) <= 90
  );
}

/** Remove the last vertex. @returns {boolean} whether one was removed */
export function removeLastVertex(session) {
  if (!session?.vertices?.length) return false;
  session.vertices.pop();
  return true;
}

/**
 * Why a session can or cannot become an annotation.
 * - `too-few`: not enough vertices yet.
 * - `degenerate`: enough vertices, but they describe nothing — three collinear
 *   points enclose no area, and a line that doubles back on itself has no
 *   length. Drawing one of those and calling it a mark would put an invisible
 *   entity on the board that the person cannot see, select or explain.
 * @returns {'ok'|'too-few'|'degenerate'|'invalid'}
 */
export function finishReason(session) {
  if (!session || !Array.isArray(session.vertices)) return 'invalid';
  if (session.vertices.some((vertex) => !isFiniteCoordinate(vertex)))
    return 'invalid';
  if (session.vertices.length < (MIN_VERTICES[session.shape] || 1))
    return 'too-few';
  if (
    session.shape === 'line' &&
    pathLengthM(session.vertices) < MIN_PATH_LENGTH_M
  )
    return 'degenerate';
  if (session.shape === 'area' && ringAreaM2(session.vertices) < MIN_AREA_M2)
    return 'degenerate';
  return 'ok';
}

/** @returns {boolean} whether the session can become an annotation right now */
export function canFinish(session) {
  return finishReason(session) === 'ok';
}

/** Length of an open path in metres. */
export function pathLengthM(vertices) {
  let m = 0;
  for (let i = 1; i < (vertices?.length || 0); i += 1)
    m += greatCircleM(vertices[i - 1], vertices[i]);
  return m;
}

/**
 * The same vertices with longitudes made CONTINUOUS relative to the first one,
 * so planar maths does not tear at the antimeridian. A small shape straddling
 * 180° has longitudes like [179.999, -179.999]; subtracting those raw gives
 * 359.998° of width instead of 0.002°, which is how a 25,000 m² rectangle
 * measured 4,461 km² and reported its centre on the Greenwich meridian.
 *
 * Values may leave the [-180, 180] range on purpose — that is what "continuous"
 * means. Re-wrap with `wrapLongitude` before handing one back as a coordinate.
 * @param {Array<{lon:number, lat:number}>} vertices
 */
export function unwrapLongitudes(vertices) {
  if (!vertices?.length) return [];
  const reference = vertices[0].lon;
  return vertices.map((vertex) => {
    let lon = vertex.lon;
    while (lon - reference > 180) lon -= 360;
    while (lon - reference < -180) lon += 360;
    return { ...vertex, lon };
  });
}

/** A continuous longitude brought back into [-180, 180]. */
export function wrapLongitude(lon) {
  if (!Number.isFinite(lon)) return lon;
  // A value already in range is returned UNCHANGED rather than pushed through
  // the modulo, which is only exact in binary for some inputs: 0.0005 came back
  // as 0.0004999999999881766. The seam is the only place the arithmetic is
  // needed, so it is the only place that pays for it.
  if (lon >= -180 && lon < 180) return lon;
  const value = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Object.is(value, -0) ? 0 : value;
}

/** Planar shoelace area of a ring in square metres (local metre grid; fine at whiteboard scale). */
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

/** Vertex-average centroid of a ring, {lon, lat}, safe across the antimeridian. */
export function ringCentroid(vertices) {
  if (!vertices?.length) return null;
  const ring = unwrapLongitudes(vertices);
  return {
    lon: wrapLongitude(ring.reduce((s, v) => s + v.lon, 0) / ring.length),
    lat: ring.reduce((s, v) => s + v.lat, 0) / ring.length,
  };
}

/** Distance or area, formatted for a label suffix. */
export function formatMeasure(session) {
  if (!session) return '';
  if (session.shape === 'line') {
    const m = pathLengthM(session.vertices);
    return m >= 1000
      ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`
      : `${Math.round(m)} m`;
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
 *
 * The per-vertex height from the click is dropped here, deliberately and in one
 * place: the world renderer drapes areas and routes onto the photoreal surface,
 * so a height carried this far would be discarded further downstream instead,
 * silently. What the person gets is the outline they drew, lying on the
 * surface under it.
 * @param {object} session
 * @param {{label?: string, color?: string}} [opts]
 */
export function finishSpec(session, { label = '', color = 'primary' } = {}) {
  if (!canFinish(session)) return null;
  const text = String(label || '').trim();
  const pts = session.vertices.map((v) => [v.lon, v.lat]);
  if (session.shape === 'area') {
    // CLOSED explicitly. A polygon fill closes itself, but the outline beside it
    // is a polyline, and an open ring draws every edge except the one back to
    // the first vertex — the shape reads as a shape with one side missing.
    return {
      type: 'area',
      manual: true,
      ring: closeRing(pts),
      label: text || null,
      color,
    };
  }
  if (session.shape === 'line') {
    return {
      type: 'route',
      manual: true,
      path: pts,
      label: text || null,
      color,
    };
  }
  const [lon, lat] = pts[0];
  return {
    type: 'pin',
    manual: true,
    latitude: lat,
    longitude: lon,
    label: text || null,
    color,
  };
}

/** A ring whose last position repeats its first, so an outline has no gap. */
export function closeRing(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 3) return pairs;
  const [firstLon, firstLat] = pairs[0];
  const [lastLon, lastLat] = pairs[pairs.length - 1];
  if (firstLon === lastLon && firstLat === lastLat) return pairs;
  return [...pairs, [firstLon, firstLat]];
}

/** One line of guidance for the person drawing, by state. */
export function drawHint(session) {
  if (!session) return 'Pick a shape, then click the map.';
  const n = session.vertices.length;
  if (session.shape === 'pin')
    return n
      ? 'Enter to place the pin, Esc to cancel.'
      : 'Click where the pin goes.';
  const need = MIN_VERTICES[session.shape] - n;
  if (need > 0) return `Click ${need} more point${need === 1 ? '' : 's'}.`;
  if (finishReason(session) === 'degenerate') {
    return session.shape === 'area'
      ? 'Those points are in a line — move one off it to enclose an area.'
      : 'That line has no length — click somewhere further away.';
  }
  const full =
    n >= MAX_VERTICES ? ` · ${MAX_VERTICES}-point limit reached` : '';
  return `${formatMeasure(session)} · double-click or Enter to finish, Backspace undoes, Esc cancels.${full}`;
}
