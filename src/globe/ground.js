// engine.ground, the engine-neutral part: sets of flat fills draped on the
// ground (terrain and 3D tiles) — polygons with holes, discs, lon/lat cells
// and corridors (ground-hugging lines of a width in pixels or metres). This
// checks options and items, keeps a set's items as plain arrays the engines
// draw from, and picks them on the CPU for the engines that need it (Navara,
// the fake engine). Ground positions are [longitude, latitude] in degrees,
// as GeoJSON stores them; colours rgba in 0..1. No engine imports.

import * as geo from '../geo/index.js';
import { createGroundPulseRegistry } from './groundPulse.js';

const GROUND_KINDS = Object.freeze(['polygon', 'disc', 'cell', 'corridor']);
const GROUND_DRAPES = Object.freeze(['both', 'terrain', 'tiles']);

const isFiniteNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value);
const isObject = (value) => value != null && typeof value === 'object';
const isList = (value) => Array.isArray(value) || ArrayBuffer.isView(value);

function fail(message) {
  throw new TypeError(`Ground set: ${message}`);
}

const isColor = (value) =>
  isList(value) &&
  value.length === 4 &&
  Array.prototype.every.call(
    value,
    (channel) => isFiniteNumber(channel) && channel >= 0 && channel <= 1,
  );

/** createSet options with defaults, or a TypeError. */
export function normalizeGroundSetOptions(options) {
  if (!isObject(options)) fail('options must be an object');
  const { id, kind } = options;
  if (typeof id !== 'string' || !id) fail('id must be a non-empty string');
  if (!GROUND_KINDS.includes(kind))
    fail(`kind must be one of ${GROUND_KINDS.join(', ')}: ${kind}`);
  const order = options.order ?? 0;
  if (!isFiniteNumber(order)) fail(`order must be a number: ${order}`);
  if (options.pickable !== undefined && typeof options.pickable !== 'boolean')
    fail('pickable must be a boolean');
  if (options.dynamic !== undefined && typeof options.dynamic !== 'boolean')
    fail('dynamic must be a boolean');
  if (
    options.reveal !== undefined &&
    (typeof options.reveal !== 'boolean' ||
      kind !== 'corridor' ||
      options.pickable)
  )
    fail('reveal needs an unpickable corridor set');
  const drape = options.drape ?? 'both';
  if (!GROUND_DRAPES.includes(drape))
    fail(`drape must be one of ${GROUND_DRAPES.join(', ')}: ${drape}`);
  return {
    id,
    kind,
    order,
    pickable: options.pickable === true,
    drape,
    ...(options.dynamic ? { dynamic: true } : {}),
    ...(options.reveal ? { reveal: true } : {}),
  };
}

function lonLat(value, label) {
  if (
    !isList(value) ||
    value.length < 2 ||
    !isFiniteNumber(value[0]) ||
    !isFiniteNumber(value[1]) ||
    value[1] < -90 ||
    value[1] > 90
  )
    fail(`${label} must be [longitude, latitude] in degrees`);
  return value;
}

// A ring or line as a flat Float64Array [lon, lat, …], each longitude
// within 180° of the one before (a ring across the antimeridian stays in
// one piece); a ring's closing copy of its first point is dropped.
function flatPath(points, label, { ring }) {
  if (!Array.isArray(points)) fail(`${label} must be an array of positions`);
  const flat = [];
  let previous = null;
  points.forEach((point, index) => {
    const [lon, lat] = lonLat(point, `${label} position ${index}`);
    const unwrapped =
      previous === null ? lon : lon - 360 * Math.round((lon - previous) / 360);
    flat.push(unwrapped, lat);
    previous = unwrapped;
  });
  const count = flat.length / 2;
  if (
    ring &&
    count > 1 &&
    Math.abs(flat[0] - flat[(count - 1) * 2]) < 1e-12 &&
    flat[1] === flat[(count - 1) * 2 + 1]
  )
    flat.length -= 2;
  const minimum = ring ? 3 : 2;
  if (flat.length / 2 < minimum)
    fail(`${label} needs at least ${minimum} distinct positions`);
  return Float64Array.from(flat);
}

function fillOf(item) {
  if (item.fill == null) return null;
  if (!isColor(item.fill)) fail('fill must be [r, g, b, a] in 0..1');
  return Float32Array.from(item.fill);
}

function outlineOf(item) {
  const outline = item.outline;
  if (outline == null) return null;
  if (!isObject(outline) || !isColor(outline.color))
    fail('outline must be { color: [r, g, b, a], widthPx }');
  if (!(isFiniteNumber(outline.widthPx) && outline.widthPx > 0))
    fail(`outline.widthPx must be a positive number: ${outline.widthPx}`);
  return { color: Float32Array.from(outline.color), widthPx: outline.widthPx };
}

// A disc's radius fractions and alpha envelope, independent of its colour.
function radialOf(item) {
  if (item.radial == null) return null;
  const { fillAlpha, rimAlpha, rimStart, rimEnd, emission } = item.radial;
  if (
    !item.fill ||
    ![fillAlpha, rimAlpha, rimStart, rimEnd].every(unit) ||
    !(rimStart < rimEnd && rimEnd < 1) ||
    !(isFiniteNumber(emission) && emission >= 0)
  )
    fail(
      'radial needs fill, alpha in 0..1, 0 <= rimStart < rimEnd < 1 and emission >= 0',
    );
  return Object.freeze({ fillAlpha, rimAlpha, rimStart, rimEnd, emission });
}

function boundsOf(paths) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const flat of paths)
    for (let index = 0; index < flat.length; index += 2) {
      west = Math.min(west, flat[index]);
      east = Math.max(east, flat[index]);
      south = Math.min(south, flat[index + 1]);
      north = Math.max(north, flat[index + 1]);
    }
  return { west, south, east, north };
}

const EARTH_RADIUS = geo.ellipsoid.WGS84.maximumRadius;
const DEGREE_M = (Math.PI / 180) * EARTH_RADIUS;

/**
 * One item of a set of `kind`, checked, as the engines draw it:
 * { rings: Float64Array[] (polygon and cell, outer first; a cell's corners),
 *   center, radiusM (disc), path: Float64Array (corridor), fill, outline,
 *   widthPx | widthM (corridor), pickId, bounds (degrees) }.
 */
export function normalizeGroundItem(kind, item, index = 0) {
  if (!isObject(item)) fail(`item ${index} must be an object`);
  const base = { pickId: item.pickId };
  if (item.radial != null && kind !== 'disc') fail('radial needs a disc');
  if (kind === 'polygon') {
    if (!Array.isArray(item.rings) || !item.rings.length)
      fail(`item ${index} needs rings: [outer, ...holes]`);
    const rings = item.rings.map((ring, at) =>
      flatPath(ring, `item ${index} ring ${at}`, { ring: true }),
    );
    // Holes in the outer ring's longitudes.
    for (const hole of rings.slice(1)) {
      const shift = 360 * Math.round((hole[0] - rings[0][0]) / 360);
      for (let at = 0; at < hole.length; at += 2) hole[at] -= shift;
    }
    return {
      ...base,
      rings,
      fill: fillOf(item),
      outline: outlineOf(item),
      bounds: boundsOf(rings.slice(0, 1)),
    };
  }
  if (kind === 'disc') {
    const center = lonLat(item.center, `item ${index} center`);
    if (!(isFiniteNumber(item.radiusM) && item.radiusM > 0))
      fail(`item ${index} radiusM must be a positive number`);
    const dLat = item.radiusM / DEGREE_M;
    const dLon = dLat / Math.max(1e-6, Math.cos(geo.math.toRadians(center[1])));
    return {
      ...base,
      center: [center[0], center[1]],
      radiusM: item.radiusM,
      radial: radialOf(item),
      fill: fillOf(item),
      outline: outlineOf(item),
      bounds: {
        west: center[0] - dLon,
        east: center[0] + dLon,
        south: Math.max(-90, center[1] - dLat),
        north: Math.min(90, center[1] + dLat),
      },
    };
  }
  if (kind === 'cell') {
    const { west, south, east, north } = item;
    if (
      ![west, south, east, north].every(isFiniteNumber) ||
      south >= north ||
      south < -90 ||
      north > 90
    )
      fail(`item ${index} must be { west, south, east, north } in degrees`);
    const eastBound = east <= west ? east + 360 : east;
    return {
      ...base,
      rings: [
        Float64Array.of(
          west,
          south,
          eastBound,
          south,
          eastBound,
          north,
          west,
          north,
        ),
      ],
      fill: fillOf(item),
      outline: outlineOf(item),
      bounds: { west, south, east: eastBound, north },
    };
  }
  // corridor
  const path = flatPath(item.positions, `item ${index} positions`, {
    ring: false,
  });
  if (!isColor(item.color)) fail(`item ${index} color must be [r, g, b, a]`);
  const hasPx = item.widthPx !== undefined;
  const hasM = item.widthM !== undefined;
  if (hasPx === hasM) fail(`item ${index} needs widthPx or widthM`);
  const width = hasPx ? item.widthPx : item.widthM;
  if (!(isFiniteNumber(width) && width > 0))
    fail(`item ${index} width must be a positive number`);
  const animation = animationOf(item, index);
  if (animation && !hasPx)
    fail(`item ${index} glow, pulse and dash need widthPx`);
  return {
    ...base,
    path,
    fill: Float32Array.from(item.color),
    outline: null,
    ...(hasPx ? { widthPx: width } : { widthM: width }),
    animation,
    bounds: boundsOf([path]),
  };
}

const unit = (value) => isFiniteNumber(value) && value >= 0 && value <= 1;

// A pixel corridor's look over its width and time, as Cesium's ground
// polyline materials drew it: `glow` PolylineGlow's falloff, `pulse` its
// alpha going up and down, `dash` the annotation route's flowing dashes.
// Null without any.
function animationOf(item, index) {
  const { glow, pulse, dash, dashPattern, backing } = item;
  if (
    glow == null &&
    pulse == null &&
    dash == null &&
    dashPattern == null &&
    backing == null
  )
    return null;
  if (dashPattern != null) {
    if (
      !isObject(dashPattern) ||
      !isFiniteNumber(dashPattern.lengthPx) ||
      dashPattern.lengthPx <= 0
    )
      fail(`item ${index} dashPattern.lengthPx must be positive`);
    const pattern = dashPattern.pattern ?? 255;
    if (!Number.isInteger(pattern) || pattern < 0 || pattern > 65535)
      fail(`item ${index} dashPattern.pattern must be a 16-bit integer`);
    if (glow != null || pulse != null || dash != null || backing != null)
      fail(
        `item ${index} dashPattern cannot combine with other corridor looks`,
      );
    return Object.freeze({
      pattern: Object.freeze({ lengthPx: dashPattern.lengthPx, pattern }),
    });
  }
  const label = `item ${index}`;
  let glowOut = null;
  if (glow != null) {
    if (!isObject(glow)) fail(`${label} glow must be { power, taper }`);
    const taper = glow.taper ?? 1;
    if (!(isFiniteNumber(glow.power) && glow.power > 0 && glow.power <= 0.5))
      fail(`${label} glow.power must be in (0, 0.5]: ${glow.power}`);
    if (!(isFiniteNumber(taper) && taper > 0 && taper <= 1))
      fail(`${label} glow.taper must be in (0, 1]: ${taper}`);
    glowOut = Object.freeze({ power: glow.power, taper });
  }
  let pulseOut = null;
  if (pulse != null) {
    if (!isObject(pulse)) fail(`${label} pulse must be { periodMs, min, max }`);
    const { periodMs, min, max } = pulse;
    if (!(isFiniteNumber(periodMs) && periodMs > 0))
      fail(`${label} pulse.periodMs must be a positive number: ${periodMs}`);
    if (!unit(min) || !unit(max) || min > max)
      fail(`${label} pulse needs 0 <= min <= max <= 1: ${min}, ${max}`);
    pulseOut = Object.freeze({ periodMs, min, max });
  }
  let dashOut = null;
  if (dash != null) {
    if (!isObject(dash))
      fail(`${label} dash must be { cells, duty, speed, gapAlpha, emission }`);
    const { cells, duty } = dash;
    const speed = dash.speed ?? 0;
    const gapAlpha = dash.gapAlpha ?? 0;
    const emission = dash.emission ?? 0;
    if (!(isFiniteNumber(cells) && cells > 0))
      fail(`${label} dash.cells must be a positive number: ${cells}`);
    if (!(isFiniteNumber(duty) && duty > 0 && duty < 1))
      fail(`${label} dash.duty must be in (0, 1): ${duty}`);
    if (!isFiniteNumber(speed))
      fail(`${label} dash.speed must be a number: ${speed}`);
    if (!unit(gapAlpha))
      fail(`${label} dash.gapAlpha must be in 0..1: ${gapAlpha}`);
    if (!(isFiniteNumber(emission) && emission >= 0))
      fail(`${label} dash.emission must be a number >= 0: ${emission}`);
    dashOut = Object.freeze({ cells, duty, speed, gapAlpha, emission });
  }
  let backingOut = null;
  if (backing != null) {
    if (
      !isObject(backing) ||
      !isColor(backing.color) ||
      !isFiniteNumber(backing.widthPx) ||
      !(backing.widthPx > item.widthPx)
    )
      fail(
        `${label} backing needs a colour and a widthPx larger than the core`,
      );
    backingOut = Object.freeze({
      color: Object.freeze([...backing.color]),
      widthPx: backing.widthPx,
    });
  }
  return Object.freeze({
    glow: glowOut,
    pulse: pulseOut,
    dash: dashOut,
    ...(backingOut ? { backing: backingOut } : {}),
  });
}

/** Whether a checked item changes over time (a pulse or a dash). */
export const animates = (item) =>
  Boolean(item.animation?.pulse || item.animation?.dash);

/**
 * The time animated corridors are drawn at, in seconds: the page's
 * monotonic clock, as Cesium's route and heat-line materials read it (not
 * the app clock: a frozen or sped-up scene time leaves them as they are).
 */
export const groundSeconds = () => performance.now() / 1000;

/** A pulse's alpha factor at `seconds`: min..max, a sine of its period. */
export function pulseFactor({ periodMs, min, max }, seconds) {
  const wave = Math.sin((2 * Math.PI * seconds * 1000) / periodMs);
  return min + (max - min) * (0.5 + 0.5 * wave);
}

/** Half the soft edge of a dash, in cells (the route flow material's). */
export const DASH_EDGE = 0.08;

/** A disc's boundary as a ring of `segments` points (degrees, flat). */
export function discRing({ center, radiusM }, segments = 64) {
  const origin = geo.cartesian3.fromDegrees(center[0], center[1]);
  const up = geo.ellipsoid.WGS84.geodeticSurfaceNormal(
    origin,
    geo.cartesian3.create(),
  );
  const east = geo.cartesian3.normalize(
    geo.cartesian3.create(-origin.y, origin.x, 0),
    geo.cartesian3.create(),
  );
  if (!Number.isFinite(east.x)) Object.assign(east, { x: 1, y: 0, z: 0 });
  const north = geo.cartesian3.cross(up, east, geo.cartesian3.create());
  const angle = radiusM / geo.cartesian3.magnitude(origin);
  const flat = new Float64Array(segments * 2);
  const point = geo.cartesian3.create();
  let previous = null;
  for (let index = 0; index < segments; index++) {
    const theta = (index * 2 * Math.PI) / segments;
    const along = Math.sin(angle) * geo.cartesian3.magnitude(origin);
    const a = Math.sin(theta) * along;
    const b = Math.cos(theta) * along;
    point.x = origin.x * Math.cos(angle) + east.x * a + north.x * b;
    point.y = origin.y * Math.cos(angle) + east.y * a + north.y * b;
    point.z = origin.z * Math.cos(angle) + east.z * a + north.z * b;
    const place = geo.cartographic.fromCartesian(point);
    let lon = geo.math.toDegrees(place.longitude);
    if (previous !== null) lon -= 360 * Math.round((lon - previous) / 360);
    previous = lon;
    flat[index * 2] = lon;
    flat[index * 2 + 1] = geo.math.toDegrees(place.latitude);
  }
  return flat;
}

/**
 * A cell's boundary with its parallels split into steps of at most
 * `stepDeg` degrees (meridians are great circles and stay two points).
 */
export function cellRing({ bounds }, stepDeg = 0.25) {
  const { west, south, east, north } = bounds;
  const steps = Math.max(1, Math.ceil((east - west) / stepDeg));
  const flat = [];
  for (let index = 0; index <= steps; index++)
    flat.push(west + ((east - west) * index) / steps, south);
  for (let index = steps; index >= 0; index--)
    flat.push(west + ((east - west) * index) / steps, north);
  return Float64Array.from(flat);
}

/** The rings an item's area draws: a polygon's, a disc's or a cell's. */
export function areaRings(kind, item, { discSegments = 64, cellStepDeg } = {}) {
  if (kind === 'disc') return [discRing(item, discSegments)];
  if (kind === 'cell') return [cellRing(item, cellStepDeg)];
  return item.rings;
}

/**
 * engine.ground over an engine's drawing: `build(options)` returns the
 * engine part of one set ({ commit(items), show(visible), destroy(),
 * ready?() }), called with checked items. Set ids are unique while the set
 * lives; destroyAll() is for the engine's destroy.
 */
export function createGroundRegistry(build, { pulseField } = {}) {
  const live = new Map();
  const pulses = createGroundPulseRegistry(pulseField, (id) => live.has(id));
  const ground = {
    createPulseField: pulses.create,
    createSet(input) {
      const options = normalizeGroundSetOptions(input);
      if (live.has(options.id) || pulses.live.has(options.id))
        throw new Error(`Ground set ${options.id} already exists`);
      const part = build(options);
      const state = {
        options,
        part,
        pending: [],
        // What the last commit drew: picks read it.
        items: [],
        shown: true,
        reveal: 1,
        // Whether the last commit has a pulse or a dash.
        animated: false,
        destroyed: false,
      };
      const alive = () => {
        if (state.destroyed) throw new Error('Ground set was destroyed');
      };
      const set = {
        id: options.id,
        replace(items) {
          alive();
          if (!Array.isArray(items)) fail('items must be an array');
          state.pending = items.map((item, index) => {
            const checked = normalizeGroundItem(options.kind, item, index);
            if (options.reveal) {
              if (!checked.widthPx || checked.animation?.pattern)
                fail('reveal needs pixel corridors without dashPattern');
              checked.animation ??= {};
            }
            return checked;
          });
        },
        commit() {
          alive();
          state.items = state.pending;
          state.animated = state.items.some(animates);
          part.commit(state.items);
        },
        show(visible) {
          alive();
          state.shown = Boolean(visible);
          part.show(state.shown);
        },
        setReveal(fraction) {
          alive();
          if (!options.reveal || !unit(fraction))
            fail('setReveal needs a reveal set and fraction in 0..1');
          if (state.reveal === fraction) return;
          state.reveal = fraction;
          part.reveal?.(fraction);
        },
        shown: () => state.shown,
        count: () => state.items.length,
        ready: () =>
          !state.destroyed && (part.ready ? part.ready() === true : true),
        destroy() {
          if (state.destroyed) return;
          state.destroyed = true;
          live.delete(options.id);
          part.destroy();
          state.pending = [];
          state.items = [];
          state.animated = false;
        },
        isDestroyed: () => state.destroyed,
      };
      state.set = set;
      live.set(options.id, state);
      return set;
    },
    list: () =>
      [...live.values()]
        .map(({ options, items, shown, animated }) => ({
          id: options.id,
          kind: options.kind,
          count: items.length,
          shown,
          order: options.order,
          animated,
        }))
        .concat(pulses.list()),
  };
  return {
    ground,
    live,
    pulses: pulses.live,
    /**
     * Whether a shown set has a pulse or a dash: the engine draws a frame
     * after every frame while it does, as Cesium's continuous render did.
     */
    animating() {
      for (const state of live.values())
        if (state.shown && state.animated) return true;
      return false;
    },
    destroyAll() {
      pulses.destroyAll();
      for (const state of [...live.values()]) state.set.destroy();
    },
  };
}

// Even-odd point in a flat [lon, lat, …] ring, in local x/y.
function inRing(flat, x, y, toLocal) {
  let inside = false;
  const count = flat.length / 2;
  let [ax, ay] = toLocal(flat[(count - 1) * 2], flat[(count - 1) * 2 + 1]);
  for (let index = 0; index < count; index++) {
    const [bx, by] = toLocal(flat[index * 2], flat[index * 2 + 1]);
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax)
      inside = !inside;
    ax = bx;
    ay = by;
  }
  return inside;
}

function pathDistance(flat, closed, x, y, toLocal) {
  const count = flat.length / 2;
  let best = Infinity;
  let [ax, ay] = closed
    ? toLocal(flat[(count - 1) * 2], flat[(count - 1) * 2 + 1])
    : toLocal(flat[0], flat[1]);
  for (let index = closed ? 0 : 1; index < count; index++) {
    const [bx, by] = toLocal(flat[index * 2], flat[index * 2 + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared > 0
        ? Math.max(
            0,
            Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared),
          )
        : 0;
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
    ax = bx;
    ay = by;
  }
  return best;
}

/** Outlines and px corridors are picked at least this far out, in pixels. */
const GROUND_PICK_PX = 3;

/**
 * CPU picks of ground sets: the ground under a window position
 * (`pickGlobe`), tested against the shown, pickable sets' committed items
 * (a fill inside its rings, minus holes; an outline or corridor within half
 * its width + 3 px). Hits rank under every mover and line (onTop −1), then
 * by set order (higher on top), then the later item of a set on top.
 * @param {{ pickGlobe: (at: object) => (object | undefined),
 *   camera: { livePosition: object, pose: () => { fovy: number } },
 *   size: () => { width: number, height: number },
 *   sets: () => { options: object, items: object[], shown: boolean }[],
 *   surface?: () => 'terrain' | 'tiles' }} ports `surface`: what the ground
 *   is now (3D tiles while they show); a set draped only on the other one
 *   draws nothing there and is not picked.
 * @returns {(at: { x: number, y: number }) => { onTop: number, order: number, depth: number, result: object }[]}
 */
export function createGroundPicks({
  pickGlobe,
  camera,
  size,
  sets,
  surface = () => 'terrain',
}) {
  return (at) => {
    const under = surface();
    const candidates = sets().filter(
      (state) =>
        state.shown &&
        state.options.pickable &&
        state.items.length &&
        (state.options.drape ?? 'both') !==
          (under === 'tiles' ? 'terrain' : 'tiles'),
    );
    if (!candidates.length) return [];
    const world = pickGlobe(at);
    if (!world) return [];
    const place = geo.cartographic.fromCartesian(world);
    if (!place) return [];
    const lon0 = geo.math.toDegrees(place.longitude);
    const lat0 = geo.math.toDegrees(place.latitude);
    const cosLat = Math.cos(place.latitude);
    // Equirectangular metres around the picked point.
    const toLocal = (lon, lat) => [
      (lon - lon0 - 360 * Math.round((lon - lon0) / 360)) * DEGREE_M * cosLat,
      (lat - lat0) * DEGREE_M,
    ];
    const depth = geo.cartesian3.distance(world, camera.livePosition);
    const metresPerPixel =
      (2 * Math.tan(camera.pose().fovy / 2) * depth) /
      Math.max(1, size().height);
    const hits = [];
    for (const { options, items } of candidates) {
      const marginDeg =
        (64 * metresPerPixel) / DEGREE_M / Math.max(0.01, cosLat);
      for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        if (item.pickId === undefined) continue;
        const { bounds } = item;
        const lon =
          lon0 -
          360 * Math.round((lon0 - (bounds.west + bounds.east) / 2) / 360);
        const extra =
          options.kind === 'corridor' && item.widthM
            ? item.widthM / DEGREE_M / Math.max(0.01, cosLat)
            : 0;
        if (
          lat0 < bounds.south - marginDeg - extra ||
          lat0 > bounds.north + marginDeg + extra ||
          lon < bounds.west - marginDeg - extra ||
          lon > bounds.east + marginDeg + extra
        )
          continue;
        let hit = false;
        if (options.kind === 'corridor') {
          const distance = pathDistance(item.path, false, 0, 0, toLocal);
          const half = item.widthM
            ? item.widthM / 2 + GROUND_PICK_PX * metresPerPixel
            : (item.widthPx / 2 + GROUND_PICK_PX) * metresPerPixel;
          hit = distance <= half;
        } else if (options.kind === 'disc') {
          const distance = geo.cartesian3.distance(
            world,
            geo.cartesian3.fromDegrees(
              item.center[0],
              item.center[1],
              place.height,
            ),
          );
          hit =
            (item.fill && distance <= item.radiusM) ||
            (item.outline &&
              Math.abs(distance - item.radiusM) <=
                (item.outline.widthPx / 2 + GROUND_PICK_PX) * metresPerPixel);
        } else {
          const rings =
            options.kind === 'cell' ? [cellRing(item, 1)] : item.rings;
          if (item.fill)
            hit =
              inRing(rings[0], 0, 0, toLocal) &&
              !rings.slice(1).some((ring) => inRing(ring, 0, 0, toLocal));
          if (!hit && item.outline)
            hit = rings.some(
              (ring) =>
                pathDistance(ring, true, 0, 0, toLocal) <=
                (item.outline.widthPx / 2 + GROUND_PICK_PX) * metresPerPixel,
            );
        }
        if (hit)
          hits.push({
            onTop: -1,
            order: options.order,
            depth,
            result: { id: item.pickId, owner: options.id, instance: index },
          });
      }
    }
    return hits;
  };
}
