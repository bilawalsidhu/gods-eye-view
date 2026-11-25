/**
 * @module cctvGizmo
 *
 * Direct-manipulation calibration gizmo for the CCTV layer (design:
 * docs/superpowers/specs/2026-07-05-cctv-viewshed-gizmo-design.md §3c).
 *
 * Two layers:
 *  - Pure drag math (this top section): ray↔axis closest-point, ray↔plane
 *    intersection with a grazing-angle guard, ring angles. All unit-tested
 *    under node:test with zero scene dependencies.
 *  - createCalibrationGizmo (below): the draw-set + pointer-input
 *    controller that renders grab-able handles on the ACTIVE camera and turns
 *    drags into calibration patches through a narrow callback interface. It
 *    never touches the layer's records/stores directly.
 *
 * Every one of the 7 calibration DOF maps to a handle:
 *   heading ring (yaw, local-up plane) · pitch ring (around local right) ·
 *   East/North/Up arrows (offsets + mount height) · range handle at the
 *   far-cap center (monitor-plane distance) · FOV handles at the cap's
 *   left/right edge midpoints (plane size).
 *
 * Scene interaction is strictly event-driven (single pick on LEFT_DOWN,
 * throttled hover picks while ADJUST mode is on) — the layer's zero-steady-state-query
 * invariant is untouched.
 */
import { inputFor } from '../input/dispatcher.js';
import { canvasOf, drawOf, findQuery } from '../render/rendererOf.js';
import { eastNorthUp } from '../geo/frames.js';
import { add, dot, scale, sub } from '../geo/vector.js';

// Grazing guard (spec §5): reject plane intersections when the view ray is
// nearly parallel to the constraint plane — the hit point races to infinity
// and a 1 px mouse move would slam the value.
const GRAZING_DOT_MIN = 0.08;
// Near-parallel guard for ray/axis closest-point (denominator 1 - (d·a)²).
const PARALLEL_EPS = 1e-6;

/**
 * Parameter t (metres) along an axis line of the point on that axis closest
 * to a mouse ray. Both directions must be normalized.
 *
 * Minimizing |(rayOrigin + s·rayDir) − (axisOrigin + t·axisDir)|² gives
 *   t = (e − b·d) / (1 − b²)   with b = rayDir·axisDir, w = rayOrigin − axisOrigin,
 *                                    d = rayDir·w,      e = axisDir·w.
 *
 * Vectors are ECEF `{x, y, z}`.
 * @param {{x: number, y: number, z: number}} rayOrigin
 * @param {{x: number, y: number, z: number}} rayDir - Unit.
 * @param {{x: number, y: number, z: number}} axisOrigin
 * @param {{x: number, y: number, z: number}} axisDir - Unit.
 * @returns {number|null} Axis parameter in metres, or null when near-parallel.
 */
export function closestParamOnAxis(rayOrigin, rayDir, axisOrigin, axisDir) {
  const b = dot(rayDir, axisDir);
  const denom = 1 - b * b;
  if (Math.abs(denom) < PARALLEL_EPS) return null;
  const w = sub(rayOrigin, axisOrigin);
  const d = dot(rayDir, w);
  const e = dot(axisDir, w);
  return (e - b * d) / denom;
}

/**
 * Intersects a mouse ray with a plane, refusing grazing configurations
 * (|rayDir·normal| < 0.08) and hits behind the ray origin.
 * @param {{x: number, y: number, z: number}} rayOrigin
 * @param {{x: number, y: number, z: number}} rayDir - Unit.
 * @param {{x: number, y: number, z: number}} planeOrigin
 * @param {{x: number, y: number, z: number}} planeNormal - Unit.
 * @returns {{x: number, y: number, z: number}|null} Hit point (new), or null.
 */
export function rayPlaneIntersect(rayOrigin, rayDir, planeOrigin, planeNormal) {
  const denom = dot(rayDir, planeNormal);
  if (Math.abs(denom) < GRAZING_DOT_MIN) return null;
  const s = dot(sub(planeOrigin, rayOrigin), planeNormal) / denom;
  if (s < 0) return null;
  return add(rayOrigin, scale(rayDir, s));
}

/**
 * Angle (radians, atan2 convention) of a point around a ring center in the
 * plane spanned by two orthonormal basis vectors.
 * @param {{x: number, y: number, z: number}} hitPoint - Point on/near the ring plane.
 * @param {{x: number, y: number, z: number}} center - Ring center.
 * @param {{x: number, y: number, z: number}} basisA - In-plane unit vector (angle 0).
 * @param {{x: number, y: number, z: number}} basisB - In-plane unit vector (angle +90°).
 * @returns {number} Angle in (−π, π].
 */
export function ringAngle(hitPoint, center, basisA, basisB) {
  const v = sub(hitPoint, center);
  return Math.atan2(dot(v, basisB), dot(v, basisA));
}

/**
 * Shortest signed angular delta from → to, wrap-safe.
 * @param {number} fromRad
 * @param {number} toRad
 * @returns {number} Delta in (−π, π].
 */
export function signedAngleDelta(fromRad, toRad) {
  const twoPi = 2 * Math.PI;
  let delta = (toRad - fromRad) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta <= -Math.PI) delta += twoPi;
  return delta;
}

// ---------------------------------------------------------------------------
// Gizmo controller
// ---------------------------------------------------------------------------

/** Item id prefix for every gizmo part — the layer's pick-owner regex and
 * click-to-select guard key off this. Gizmo parts NEVER get a camera id in
 * the layer's pick store, so the layer's selection path ignores them. */
export const GIZMO_ID_PREFIX = 'cctv-gizmo-';

const RING_SEGMENTS = 96;
const RING_RADIUS_FACTOR = 0.12;
const RING_RADIUS_MIN_M = 6;
const RING_RADIUS_MAX_M = 40;
const ARROW_LENGTH_FACTOR = 1.6;
const DRAG_THROTTLE_MS = 16;
const HOVER_THROTTLE_MS = 120;

/** A `#rrggbb` colour at `alpha`, as the renderer's 0..1 RGBA. */
function rgba(hex, alpha = 1) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255,
    alpha,
  ];
}

const COLOR_RING_HEADING = '#35d8ff';
const COLOR_RING_PITCH = '#ff5fd0';
const COLOR_MOVE_EAST = '#ff5252';
const COLOR_MOVE_NORTH = '#52ff7a';
const COLOR_MOVE_UP = '#5b8cff';
const COLOR_HANDLE = '#ffd97a';
const HANDLE_OUTLINE = [0, 0, 0, 0.7];

const toRadians = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/**
 * Local ENU unit axes at an ECEF position.
 * @param {{x: number, y: number, z: number}} position
 * @returns {{east: object, north: object, up: object}}
 */
function enuAxes(position) {
  const frame = eastNorthUp(position);
  return { east: frame.x, north: frame.y, up: frame.z };
}

/** a*sa + b*sb. */
function combine2(a, sa, b, sb) {
  return add(scale(a, sa), scale(b, sb));
}

/** The midpoint of two points. */
const midpoint = (a, b) => scale(add(a, b), 0.5);

/**
 * View-frame unit vectors for a pose within a local ENU frame: horizontal
 * forward, viewer-right, and the full pitched view axis.
 * @param {number} headingDeg - Compass heading (0 = north, +east).
 * @param {number} pitchDeg - Elevation (+up).
 * @param {{east, north, up}} axes - ENU axes at the mount.
 */
function viewAxesFor(headingDeg, pitchDeg, axes) {
  const h = toRadians(headingDeg);
  const p = toRadians(pitchDeg);
  const forwardHoriz = combine2(
    axes.east,
    Math.sin(h),
    axes.north,
    Math.cos(h),
  );
  const right = combine2(axes.east, Math.cos(h), axes.north, -Math.sin(h));
  const view = combine2(forwardHoriz, Math.cos(p), axes.up, Math.sin(p));
  return { forwardHoriz, right, view };
}

/** Circle polyline positions around `center` in the (basisA, basisB) plane. */
function ringPositions(center, radius, basisA, basisB) {
  const positions = [];
  for (let i = 0; i <= RING_SEGMENTS; i++) {
    const angle = (i / RING_SEGMENTS) * 2 * Math.PI;
    positions.push(
      add(
        center,
        combine2(
          basisA,
          Math.cos(angle) * radius,
          basisB,
          Math.sin(angle) * radius,
        ),
      ),
    );
  }
  return positions;
}

/** The ring and arrow parts: their colour, width and whether an arrow. */
const LINE_PARTS = Object.freeze([
  ['ring-heading', COLOR_RING_HEADING, 3, false],
  ['ring-pitch', COLOR_RING_PITCH, 3, false],
  ['move-east', COLOR_MOVE_EAST, 12, true],
  ['move-north', COLOR_MOVE_NORTH, 12, true],
  ['move-up', COLOR_MOVE_UP, 12, true],
]);
/** The point parts (an arrow's tip included): colour and first size. */
const POINT_PARTS = Object.freeze([
  ['move-east', COLOR_MOVE_EAST, 14],
  ['move-north', COLOR_MOVE_NORTH, 14],
  ['move-up', COLOR_MOVE_UP, 14],
  ['handle-range', COLOR_HANDLE, 13],
  ['handle-fov-l', COLOR_HANDLE, 10],
  ['handle-fov-r', COLOR_HANDLE, 10],
]);
/** Every part a pick can grab. */
const PARTS = new Set([
  ...LINE_PARTS.map(([part]) => part),
  ...POINT_PARTS.map(([part]) => part),
]);

let gizmoInstances = 0;

/**
 * Creates the calibration gizmo controller (design §3c). Renders grab-able
 * handles for the ACTIVE camera's 7 calibration DOF and turns pointer drags
 * into calibration patches through a narrow callback interface — the gizmo
 * never touches layer records/stores directly. It draws through the
 * renderer's draw port (a line set for the rings and arrows, a point set
 * for the handles and arrow tips, each item `cctv-gizmo-<part>`) and picks
 * and casts rays through its query port.
 *
 * @param {Object} deps
 * @param {object} deps.viewer - The viewer whose renderer draws it.
 * @param {function(): Object|null} deps.getActiveRecord - Returns the record
 *   the gizmo should attach to, or null to hide (layer decides: enabled +
 *   calibration mode + active camera).
 * @param {function(Object, Object): void} deps.applyPatch - Transient
 *   per-mousemove calibration patch (partial 7-field object, absolute offset
 *   values) + the PINNED drag record it applies to.
 * @param {function(Object): void} deps.endPatch - Commit-grade tail on drag
 *   end, for the PINNED drag record.
 * @returns {{setEnabled: function(boolean): void, refresh: function(): void,
 *   destroy: function(): void, isDragging: function(): boolean,
 *   isEnabled: function(): boolean, partsForTest: function(): Object}}
 */
export function createCalibrationGizmo({
  viewer,
  getActiveRecord,
  applyPatch,
  endPatch,
}) {
  let enabled = false;
  let drag = null; // { part, startCal, basePose, refs... }
  let hoveredId = null;
  let lastDragAt = 0;
  let lastHoverAt = 0;
  // Whether the parts are drawn now, and each point part's pixel size.
  let shown = false;
  const pointSizes = new Map(POINT_PARTS.map(([part, , size]) => [part, size]));
  // The parts' geometry as last drawn: ECEF line positions and point spots.
  const linePositions = new Map();
  const pointPositions = new Map();

  const input = inputFor(viewer);
  let releaseCamera = null;

  const instance = ++gizmoInstances;
  const draw = drawOf(viewer);
  const lines = draw.lines({ id: `cctv-gizmo:${instance}:lines` });
  const points = draw.points({ id: `cctv-gizmo:${instance}:points` });

  /** The rings and arrows as they now are. */
  function lineItems() {
    const items = [];
    for (const [part, color, widthPx, arrow] of LINE_PARTS) {
      const positions = linePositions.get(part);
      if (!positions) continue;
      items.push({
        id: `${GIZMO_ID_PREFIX}${part}`,
        positions,
        widthPx,
        mode: '3d',
        style: arrow
          ? { kind: 'arrow', color: rgba(color) }
          : { kind: 'solid', color: rgba(color, 0.9) },
        // Standard gizmo convention: parts behind geometry stay clearly
        // visible, just dimmed (a street-level mount buries half the heading
        // ring in sloped photogrammetry tiles — smoke-tested 2026-07-05).
        depthFail: { kind: 'solid', color: rgba(color, 0.45) },
        show: shown,
      });
    }
    return items;
  }

  /** The handles and arrow tips as they now are. */
  function pointItems() {
    const items = [];
    for (const [part, color] of POINT_PARTS) {
      const pos = pointPositions.get(part);
      if (!pos) continue;
      items.push({
        id: `${GIZMO_ID_PREFIX}${part}`,
        pos,
        pixelSize: pointSizes.get(part),
        color: rgba(color),
        outlineColor: HANDLE_OUTLINE,
        outlineWidth: 2,
        disableDepthTest: Number.POSITIVE_INFINITY,
        show: shown,
      });
    }
    return items;
  }

  function hideAll() {
    if (!shown) return;
    shown = false;
    lines.upsert(lineItems());
    points.upsert(pointItems());
  }

  /** Recomputes every handle's geometry from the active record's CURRENT pose
   * (the PINNED record while a drag is live, so handles never jump to another
   * camera mid-interaction). */
  function refresh() {
    const record = enabled ? (drag ? drag.record : getActiveRecord()) : null;
    const positions = record?.frustumPositions;
    const camera = record?.camera;
    if (!record || !positions || !camera) {
      hideAll();
      return;
    }
    const mount = positions.mount;
    const axes = enuAxes(mount);
    const { forwardHoriz } = viewAxesFor(
      camera.headingDeg,
      camera.pitchDeg,
      axes,
    );
    const rangeM = Math.max(1, Number(camera.rangeM) || 1);
    const radius = Math.min(
      RING_RADIUS_MAX_M,
      Math.max(RING_RADIUS_MIN_M, rangeM * RING_RADIUS_FACTOR),
    );
    const arrowLen = radius * ARROW_LENGTH_FACTOR;

    linePositions.set(
      'ring-heading',
      ringPositions(mount, radius, axes.north, axes.east),
    );
    linePositions.set(
      'ring-pitch',
      ringPositions(mount, radius, forwardHoriz, axes.up),
    );
    const arrowTo = (dir) => [mount, add(mount, scale(dir, arrowLen))];
    for (const [part, dir] of [
      ['move-east', axes.east],
      ['move-north', axes.north],
      ['move-up', axes.up],
    ]) {
      const arrow = arrowTo(dir);
      linePositions.set(part, arrow);
      pointPositions.set(part, arrow[1]);
    }
    pointPositions.set('handle-range', positions.capCenter);
    pointPositions.set('handle-fov-l', midpoint(positions.tl, positions.bl));
    pointPositions.set('handle-fov-r', midpoint(positions.tr, positions.br));
    shown = true;
    lines.upsert(lineItems());
    points.upsert(pointItems());
  }

  /** The gizmo part a pick hit is, or null. */
  function gizmoPartFrom(hit) {
    if (!hit || (hit.set !== lines.id && hit.set !== points.id)) return null;
    const id = hit.id;
    if (typeof id !== 'string' || !id.startsWith(GIZMO_ID_PREFIX)) return null;
    const part = id.slice(GIZMO_ID_PREFIX.length);
    return PARTS.has(part) ? part : null;
  }

  function pickGizmoPart(windowPosition) {
    const query = findQuery(viewer);
    if (!query || !windowPosition) return null;
    const { x, y } = windowPosition;
    // Gizmo primitives render depth-test-free and should be the topmost pick.
    // Take the cheap single-result path first: a full drillPick can stall for
    // tens of seconds under software GL even when its first result is already
    // the gizmo. Retain drillPick for uncommon overlap/fallback cases.
    try {
      const part = gizmoPartFrom(query.pick(x, y, { width: 14, height: 14 }));
      if (part && shown) return part;
    } catch (err) {
      if (typeof window !== 'undefined' && window.__gevGizmoDebug) {
        console.debug('[CCTV:gizmo] pick threw:', err?.message || err);
      }
    }

    let results = [];
    try {
      results =
        query.drillPick(x, y, { limit: 6, width: 14, height: 14 }) || [];
    } catch (err) {
      if (typeof window !== 'undefined' && window.__gevGizmoDebug) {
        console.debug('[CCTV:gizmo] drillPick threw:', err?.message || err);
      }
      return null;
    }
    if (typeof window !== 'undefined' && window.__gevGizmoDebug) {
      console.debug(
        '[CCTV:gizmo] drillPick @',
        x,
        y,
        '→',
        JSON.stringify(
          results.map((hit) =>
            hit.surface ? '(surface)' : `${hit.set}/${hit.id}`,
          ),
        ),
      );
    }
    for (const hit of results) {
      const part = gizmoPartFrom(hit);
      if (part && shown) return part;
    }
    return null;
  }

  function pickRay(windowPosition) {
    try {
      return (
        findQuery(viewer)?.pickRay(windowPosition.x, windowPosition.y) || null
      );
    } catch {
      return null;
    }
  }

  function setCursor(value) {
    const style = canvasOf(viewer)?.style;
    if (style) style.cursor = value;
  }

  function setHovered(part) {
    const nextId = part ? `${GIZMO_ID_PREFIX}${part}` : null;
    if (nextId === hoveredId) return;
    hoveredId = nextId;
    // Hover feedback must NEVER touch line geometry: a width change rebuilds
    // the line, and until the next render the part vanishes from the pick
    // buffer — so the very hover that finds a ring makes the following
    // LEFT_DOWN miss it (root-caused via the QA harness's synthetic drag,
    // 2026-07-05). Rings/arrows get cursor feedback only; point handles
    // (an arrow's tip included) change size in place, so they keep the size
    // bump.
    for (const [name] of POINT_PARTS) {
      const hot = hoveredId === `${GIZMO_ID_PREFIX}${name}`;
      pointSizes.set(name, (name === 'handle-range' ? 13 : 10) + (hot ? 4 : 0));
    }
    points.upsert(pointItems());
    setCursor(hoveredId ? 'grab' : '');
  }

  /** Captures the fixed drag reference frame + start values for a part. */
  function beginDrag(part, windowPosition) {
    const record = getActiveRecord();
    const positions = record?.frustumPositions;
    const camera = record?.camera;
    const geometry = record?.frustumGeometry;
    if (!record || !positions || !camera?.basePose || !geometry) return false;
    const ray = pickRay(windowPosition);
    if (!ray) return false;

    const mount = { ...positions.mount };
    const capCenter = { ...positions.capCenter };
    const axes = enuAxes(mount);
    const { forwardHoriz, right, view } = viewAxesFor(
      camera.headingDeg,
      camera.pitchDeg,
      axes,
    );
    const startCal = { ...camera.calibration };
    const basePose = { ...camera.basePose };
    const state = {
      // The drag is PINNED to this record: patches must never follow a
      // mid-drag active-camera switch (voice select / auto-hop) onto a
      // different camera — its basePose makes the captured offsets wrong.
      record,
      part,
      startCal,
      basePose,
      mount,
      capCenter,
      axes,
      forwardHoriz,
      right,
      view,
      effectiveRangeM: geometry.rangeM,
      startAngle: null,
      startParam: null,
    };

    if (part === 'ring-heading') {
      const hit = rayPlaneIntersect(ray.origin, ray.direction, mount, axes.up);
      if (!hit) return false;
      state.startAngle = ringAngle(hit, mount, axes.north, axes.east); // compass convention
    } else if (part === 'ring-pitch') {
      const hit = rayPlaneIntersect(ray.origin, ray.direction, mount, right);
      if (!hit) return false;
      state.startAngle = ringAngle(hit, mount, forwardHoriz, axes.up); // 0 = level, + = up
    } else if (
      part === 'move-east' ||
      part === 'move-north' ||
      part === 'move-up'
    ) {
      const dir =
        part === 'move-east'
          ? axes.east
          : part === 'move-north'
            ? axes.north
            : axes.up;
      state.axisDir = dir;
      const t = closestParamOnAxis(ray.origin, ray.direction, mount, dir);
      if (t === null) return false;
      state.startParam = t;
    } else if (part === 'handle-range') {
      const t = closestParamOnAxis(ray.origin, ray.direction, mount, view);
      if (t === null) return false;
      state.startParam = t;
    } else if (part === 'handle-fov-l' || part === 'handle-fov-r') {
      const hit = rayPlaneIntersect(ray.origin, ray.direction, capCenter, view);
      if (!hit) return false;
    } else {
      return false;
    }

    drag = state;
    setCursor('grabbing');
    releaseCamera = input.suspendCamera('cctv-gizmo-drag');
    return true;
  }

  /** Converts the current mouse ray into a calibration patch for the drag part. */
  function dragPatch(windowPosition) {
    const ray = pickRay(windowPosition);
    if (!ray || !drag) return null;
    const {
      part,
      startCal,
      basePose,
      mount,
      capCenter,
      axes,
      forwardHoriz,
      right,
      view,
    } = drag;

    if (part === 'ring-heading') {
      const hit = rayPlaneIntersect(ray.origin, ray.direction, mount, axes.up);
      if (!hit) return null;
      const angle = ringAngle(hit, mount, axes.north, axes.east);
      return {
        headingDeg:
          startCal.headingDeg + toDeg(signedAngleDelta(drag.startAngle, angle)),
      };
    }
    if (part === 'ring-pitch') {
      const hit = rayPlaneIntersect(ray.origin, ray.direction, mount, right);
      if (!hit) return null;
      const angle = ringAngle(hit, mount, forwardHoriz, axes.up);
      return {
        pitchDeg:
          startCal.pitchDeg + toDeg(signedAngleDelta(drag.startAngle, angle)),
      };
    }
    if (part === 'move-east' || part === 'move-north' || part === 'move-up') {
      const t = closestParamOnAxis(
        ray.origin,
        ray.direction,
        mount,
        drag.axisDir,
      );
      if (t === null) return null;
      const delta = t - drag.startParam;
      if (part === 'move-east')
        return { offsetEastM: startCal.offsetEastM + delta };
      if (part === 'move-north')
        return { offsetNorthM: startCal.offsetNorthM + delta };
      return { heightM: startCal.heightM + delta };
    }
    if (part === 'handle-range') {
      const t = closestParamOnAxis(ray.origin, ray.direction, mount, view);
      if (t === null || !(basePose.rangeM > 0)) return null;
      return { rangeScale: Math.max(0.01, t) / basePose.rangeM };
    }
    if (part === 'handle-fov-l' || part === 'handle-fov-r') {
      const hit = rayPlaneIntersect(ray.origin, ray.direction, capCenter, view);
      if (!hit) return null;
      const lateral = Math.abs(dot(sub(hit, capCenter), right));
      const halfW = Math.max(0.5, lateral);
      const fovDeg = toDeg(
        2 * Math.atan(halfW / Math.max(1, drag.effectiveRangeM)),
      );
      return { fovDeg: fovDeg - basePose.fovDeg };
    }
    return null;
  }

  function endDrag() {
    if (!drag) return;
    const record = drag.record;
    drag = null;
    releaseCamera?.();
    releaseCamera = null;
    setCursor(hoveredId ? 'grab' : '');
    endPatch(record);
  }

  /** QA/debug tracing, on when the page sets `window.__gevGizmoDebug = true`. */
  function debugLog(...args) {
    if (typeof window !== 'undefined' && window.__gevGizmoDebug) {
      console.debug('[CCTV:gizmo]', ...args);
    }
  }

  // An ambient press: the dispatcher withholds it while a tool owns the pointer
  // (src/data/inputOwnership.js).
  const offDown = input.onPointer('down', (event) => {
    if (!enabled) return;
    // A release Cesium never reported (one with a modifier key held) leaves
    // the last drag open; a new press ends it, hold and patch included.
    if (drag) endDrag();
    const part = pickGizmoPart(event.position);
    debugLog('LEFT_DOWN', event.position, 'part:', part);
    if (!part) return;
    const started = beginDrag(part, event.position);
    debugLog('beginDrag', part, '→', started);
  });

  const offMove = input.onPointer('move', (event) => {
    if (!enabled) return;
    const now = Date.now();
    if (drag) {
      if (now - lastDragAt < DRAG_THROTTLE_MS) return;
      lastDragAt = now;
      // A mid-drag active-camera switch (voice select / auto-hop) ends the
      // drag: what was dragged so far stays committed to the PINNED record.
      if (getActiveRecord() !== drag.record) {
        debugLog('drag ended: active camera changed mid-drag');
        endDrag();
        return;
      }
      const patch = dragPatch(event.endPosition);
      debugLog(
        'dragPatch',
        drag.part,
        event.endPosition,
        '→',
        patch ? JSON.stringify(patch) : null,
      );
      if (patch) applyPatch(patch, drag.record);
      return;
    }
    if (now - lastHoverAt < HOVER_THROTTLE_MS) return;
    lastHoverAt = now;
    setHovered(pickGizmoPart(event.endPosition));
  });

  const offUp = input.onPointer('up', () => {
    if (!enabled) return;
    endDrag();
  });

  return {
    setEnabled(value) {
      enabled = !!value;
      if (!enabled) {
        if (drag) endDrag();
        setHovered(null);
        hideAll();
      } else {
        refresh();
      }
    },
    refresh,
    destroy() {
      if (drag) endDrag();
      offDown();
      offMove();
      offUp();
      lines.dispose();
      points.dispose();
      setCursor('');
    },
    isDragging: () => !!drag,
    isEnabled: () => enabled,
    /**
     * The parts as last drawn, by item id, for the QA harness: whether each
     * shows, a line's `positions` and a point's `pos` (an arrow has both).
     */
    partsForTest() {
      const parts = {};
      for (const item of [...lineItems(), ...pointItems()])
        parts[item.id] = { ...parts[item.id], ...item };
      for (const item of lineItems()) parts[item.id].show = item.show;
      return parts;
    },
  };
}
