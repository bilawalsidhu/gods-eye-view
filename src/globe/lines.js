// engine.lines, the engine-neutral part: dynamic polylines (trails, orbit
// rings, launch paths) with a width in CSS pixels, an optional dimmer
// copy where the scene hides them (depthFailAlpha), dashes (in pixels, or
// the launches' tactical pattern along the whole line), geodesic arcs and a
// model matrix (an orbit ring turned by GMST). This checks options, keeps
// positions as flat Float64Arrays and densifies geodesic arcs the same way
// for every engine that draws straight segments. No engine imports.

import * as geo from '../geo/index.js';

const isFiniteNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value);
const isObject = (value) => value != null && typeof value === 'object';

function fail(message) {
  throw new TypeError(`Line: ${message}`);
}

/**
 * The launches' selected-orbit pattern (layers/launches/policy.js
 * MISSION_ORBIT_PATTERN_GROUPS and MISSION_ORBIT_DASHES_PER_GROUP): along the
 * whole line, `groups` groups of one round dot and `dashes` short dashes.
 */
export const TACTICAL_DASH = Object.freeze({ groups: 4, dashes: 100 });

const LINE_ARCS = Object.freeze(['none', 'geodesic']);

const isColor = (value) =>
  (Array.isArray(value) || ArrayBuffer.isView(value)) &&
  value.length === 4 &&
  Array.prototype.every.call(value, isFiniteNumber);

const isMatrix = (value) =>
  (Array.isArray(value) || ArrayBuffer.isView(value)) &&
  value.length === 16 &&
  Array.prototype.every.call(value, isFiniteNumber);

function dashOf(dash) {
  if (dash == null) return null;
  if (dash === 'tactical') return { kind: 'tactical', ...TACTICAL_DASH };
  if (isObject(dash) && dash.tactical)
    return {
      kind: 'tactical',
      groups: dash.tactical.groups ?? TACTICAL_DASH.groups,
      dashes: dash.tactical.dashes ?? TACTICAL_DASH.dashes,
    };
  if (
    isObject(dash) &&
    isFiniteNumber(dash.lengthPx) &&
    dash.lengthPx > 0 &&
    isFiniteNumber(dash.gapPx) &&
    dash.gapPx >= 0
  )
    return { kind: 'pixels', lengthPx: dash.lengthPx, gapPx: dash.gapPx };
  return fail("dash must be { lengthPx, gapPx }, 'tactical' or null");
}

/** createLine options with defaults, or a TypeError. */
export function normalizeLineOptions(options) {
  if (!isObject(options)) fail('options must be an object');
  const { id, widthPx, color } = options;
  if (typeof id !== 'string' || !id) fail('id must be a non-empty string');
  if (!(isFiniteNumber(widthPx) && widthPx > 0))
    fail(`widthPx must be a positive number: ${widthPx}`);
  if (!isColor(color)) fail('color must be [r, g, b, a]');
  const arc = options.arc ?? 'none';
  if (!LINE_ARCS.includes(arc)) fail(`arc must be 'none' or 'geodesic'`);
  const depthFailAlpha = options.depthFailAlpha ?? 0;
  if (!(
    isFiniteNumber(depthFailAlpha) &&
    depthFailAlpha >= 0 &&
    depthFailAlpha <= 1
  ))
    fail('depthFailAlpha must be in 0..1');
  const modelMatrix = options.modelMatrix ?? null;
  if (modelMatrix !== null && !isMatrix(modelMatrix))
    fail('modelMatrix must be 16 numbers');
  return {
    id,
    widthPx,
    color: [...color],
    arc,
    depthFailAlpha,
    dash: dashOf(options.dash),
    ...(options.arrow === true ? { arrow: true } : {}),
    modelMatrix: modelMatrix ? [...modelMatrix] : null,
    pickId: options.pickId,
    order: isFiniteNumber(options.order) ? options.order : 0,
  };
}

/** Positions as one flat Float64Array [x, y, z, …]. */
export function flattenPositions(positions) {
  if (ArrayBuffer.isView(positions)) {
    if (positions.length % 3 !== 0) fail('a flat position array needs x, y, z');
    if (!Array.prototype.every.call(positions, isFiniteNumber))
      fail('positions must be finite');
    return Float64Array.from(positions);
  }
  if (!Array.isArray(positions)) fail('positions must be an array');
  const flat = new Float64Array(positions.length * 3);
  positions.forEach((position, index) => {
    if (
      !isObject(position) ||
      !isFiniteNumber(position.x) ||
      !isFiniteNumber(position.y) ||
      !isFiniteNumber(position.z)
    )
      fail(`position ${index} is not a finite Cartesian3`);
    flat[index * 3] = position.x;
    flat[index * 3 + 1] = position.y;
    flat[index * 3 + 2] = position.z;
  });
  return flat;
}

const scratchA = geo.cartesian3.create();
const scratchNormal = geo.cartesian3.create();

/**
 * Densifies straight segments into geodesic arcs: between each pair of
 * points, steps of at most `granularity` radians along the great circle of
 * their geodetic normals, the height interpolated linearly (Cesium's
 * PolylineGeometry GEODESIC arcs, to within its own sampling).
 */
export function densifyGeodesic(flat, granularity = Math.PI / 180) {
  const count = flat.length / 3;
  if (count < 2) return Float64Array.from(flat);
  const out = [];
  const ellipsoid = geo.ellipsoid.WGS84;
  const carto = (index) =>
    geo.cartographic.fromCartesian(
      geo.cartesian3.fromElements(
        flat[index * 3],
        flat[index * 3 + 1],
        flat[index * 3 + 2],
        scratchA,
      ),
      ellipsoid,
    );
  const normal = (place) => {
    const cosLat = Math.cos(place.latitude);
    return [
      cosLat * Math.cos(place.longitude),
      cosLat * Math.sin(place.longitude),
      Math.sin(place.latitude),
    ];
  };
  let from = carto(0);
  for (let index = 1; index < count; index++) {
    const to = carto(index);
    const a = normal(from);
    const b = normal(to);
    const cos = Math.min(
      1,
      Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]),
    );
    const angle = Math.acos(cos);
    const steps = Math.max(1, Math.ceil(angle / granularity - 1e-9));
    const sin = Math.sin(angle);
    for (let step = index === 1 ? 0 : 1; step <= steps; step++) {
      const t = step / steps;
      let n;
      if (sin < 1e-12) n = a;
      else {
        const wa = Math.sin((1 - t) * angle) / sin;
        const wb = Math.sin(t * angle) / sin;
        n = [
          wa * a[0] + wb * b[0],
          wa * a[1] + wb * b[1],
          wa * a[2] + wb * b[2],
        ];
      }
      const length = Math.hypot(n[0], n[1], n[2]);
      const latitude = Math.asin(n[2] / length);
      const longitude = Math.atan2(n[1], n[0]);
      const height = from.height + (to.height - from.height) * t;
      geo.cartesian3.fromRadians(
        longitude,
        latitude,
        height,
        ellipsoid,
        scratchNormal,
      );
      out.push(scratchNormal.x, scratchNormal.y, scratchNormal.z);
    }
    from = to;
  }
  return Float64Array.from(out);
}

/**
 * engine.lines over an engine's drawing: `build(options)` returns the
 * engine part ({ setPositions(flat), setColor(rgba), setModelMatrix(m),
 * show(visible), destroy() }). Ids are unique while a line lives.
 */
export function createLineRegistry(build) {
  const live = new Map();
  const lines = {
    createLine(input) {
      const options = normalizeLineOptions(input);
      if (live.has(options.id))
        throw new Error(`Line ${options.id} already exists`);
      const part = build(options);
      const state = { options, part, points: 0, shown: true, destroyed: false };
      const alive = () => {
        if (state.destroyed) throw new Error('Line was destroyed');
      };
      const line = {
        setPositions(positions) {
          alive();
          const flat = flattenPositions(positions);
          state.points = flat.length / 3;
          part.setPositions(flat);
        },
        setColor(color) {
          alive();
          if (!isColor(color)) fail('color must be [r, g, b, a]');
          part.setColor([...color]);
        },
        setModelMatrix(matrix) {
          alive();
          if (!isMatrix(matrix)) fail('modelMatrix must be 16 numbers');
          part.setModelMatrix([...matrix]);
        },
        show(visible) {
          alive();
          state.shown = Boolean(visible);
          part.show(state.shown);
        },
        destroy() {
          if (state.destroyed) return;
          state.destroyed = true;
          live.delete(options.id);
          part.destroy();
        },
      };
      state.line = line;
      live.set(options.id, state);
      return line;
    },
    createSegments(input) {
      const options = normalizeLineOptions(input);
      if (
        options.arc !== 'none' ||
        options.dash ||
        options.arrow ||
        options.modelMatrix ||
        options.depthFailAlpha ||
        options.pickId !== undefined
      )
        fail(
          'segment batches use straight, solid, depth-tested world segments',
        );
      options.segments = true;
      if (live.has(options.id))
        throw new Error(`Line ${options.id} already exists`);
      const part = build(options);
      const state = {
        options,
        part,
        points: 0,
        shown: true,
        destroyed: false,
        items: [],
      };
      let pending = null;
      const alive = () => {
        if (state.destroyed) throw new Error('Line was destroyed');
      };
      const batch = {
        replace(items) {
          alive();
          if (!Array.isArray(items)) fail('segments must be an array');
          pending = items.map((item) => {
            const positions = flattenPositions(item.positions);
            if (positions.length !== 6)
              fail('a segment needs exactly two positions');
            const color = item.color ?? options.color;
            const widthPx = item.widthPx ?? options.widthPx;
            if (!isColor(color)) fail('color must be [r, g, b, a]');
            if (!(isFiniteNumber(widthPx) && widthPx > 0))
              fail('widthPx must be positive');
            return {
              positions,
              color: [...color],
              widthPx,
              pickId: item.pickId,
            };
          });
        },
        commit() {
          alive();
          if (!pending) return;
          part.setSegments(pending);
          state.items = pending;
          state.points = pending.length * 2;
          pending = null;
        },
        show(visible) {
          alive();
          state.shown = Boolean(visible);
          part.show(state.shown);
        },
        destroy() {
          if (state.destroyed) return;
          state.destroyed = true;
          live.delete(options.id);
          part.destroy();
        },
      };
      state.line = batch;
      live.set(options.id, state);
      return batch;
    },
    list: () =>
      [...live.values()].map(({ options, points, shown, items }) => ({
        id: options.id,
        points,
        shown,
        ...(options.segments
          ? { pickIds: items.map((item) => item.pickId) }
          : {}),
      })),
  };
  return {
    lines,
    live,
    destroyAll() {
      for (const state of [...live.values()]) state.line.destroy();
    },
  };
}
