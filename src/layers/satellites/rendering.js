import { drawOf, findCamera, findQuery } from '../../render/rendererOf.js';
import { fromDegreesInto } from '../../geo/ellipsoid.js';
import { distance } from '../../geo/vector.js';
import { gstime } from 'satellite.js';
import { ISS_NORAD, POSITION_UPDATE_MS, RING_ROTATION_MS } from './policy.js';

/**
 * The satellites layer's drawing, through the renderer contract's draw port:
 * a points set of the satellite dots, a points set of the tracked
 * satellite's dot, and a lines set of the orbit rings, with the per-frame
 * tick that moves them. The other parts hand it render-contract values
 * (ECEF `{x, y, z}`, colours as `[r, g, b, a]`).
 *
 * `layerState._points` keeps each satellite's dot as the point item it is
 * drawn from (NORAD id → item): its `pos` is moved in place, so a reader
 * holding it sees where the dot is now, as one holding a point primitive's
 * position did. Writes are kept and sent to the set once per frame, at the
 * end of the tick, so a catalog of thousands moves in one upsert.
 */

/** Points shrink with distance as they always have. */
const POINT_SCALE_BY_DISTANCE = Object.freeze({
  near: 1e6,
  nearValue: 1.5,
  far: 2e7,
  farValue: 0.6,
});

/**
 * The tracked satellite's dot: 14 px yellow with a white outline, drawn
 * over everything.
 */
const TRACKED_DOT = Object.freeze({
  pixelSize: 14,
  color: Object.freeze([1, 1, 0, 1]),
  outlineColor: Object.freeze([1, 1, 1, 1]),
  outlineWidth: 2,
  disableDepthTest: Number.POSITIVE_INFINITY,
});

/** An orbit ring's colour when none is given (cyan). */
const DEFAULT_RING_COLOR = Object.freeze([0, 1, 1, 1]);

/** Rings: this alpha in front of the globe, the dimmer one behind it. */
const RING_ALPHA = 0.6;
const RING_BEHIND_ALPHA = 0.35;

/** An RGBA colour with another alpha. */
const withAlpha = (color, alpha) => [color[0], color[1], color[2], alpha];

/** Layer instances so far: set ids unique to each. */
let instances = 0;

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  const {
    focusNowMs,
    getFocusTarget,
    focusPassIsNeeded,
    nearFarScalarValueAtDistance,
    advanceSpriteFocus,
    focusAlphaNeedsWrite,
    publishFocusTargetAt,
  } = services.focus;

  // The tracked satellite's per-frame ECEF sample (WS-D2), shared with the
  // tracked dot, the follow camera and the tracked card. Tracking writes its
  // x/y/z in place.
  layerState._trackedFrameCartesian = { x: 0, y: 0, z: 0 };

  /** The draw sets, while attached: `{points, tracked, rings}`. */
  let sets = null;
  /** Dots changed since the last write to the set, by NORAD id. */
  const dirty = new Set();
  /** Dots removed since the last write to the set, by NORAD id. */
  const gone = new Set();
  /** Whether every dot was removed since the last write. */
  let cleared = false;
  /** Whether the satellite dots are shown. */
  let pointsShown = true;
  /**
   * The tracked dot: its item and how its position is read (the tracker's
   * callback, read as the follow camera reads it).
   */
  let trackedDot = null;
  let trackedDrawnThisTick = false;
  /** The frame the tick last ran in: the tracked sample's cache key. */
  let renderedFrame = -1;

  /**
   * Build the rigid ECEF transform that keeps an orbit path baked at one GMST
   * aligned with live SGP4 positions propagated at another epoch: a column-
   * major 4×4 rotation about Z.
   * @param {number} gmstAtBake GMST used when the path positions were baked.
   * @param {Date} nowDate Epoch whose rotating-Earth frame should be displayed.
   * @param {ArrayLike<number>} [result] A 16-element matrix to update in place.
   * @returns {ArrayLike<number>} Z-rotation from bake-time ECEF to current ECEF.
   */

  function orbitFrameModelMatrix(gmstAtBake, nowDate, result = new Array(16)) {
    const angle = -(gstime(nowDate) - gmstAtBake);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    result[0] = c;
    result[1] = s;
    result[2] = 0;
    result[3] = 0;
    result[4] = -s;
    result[5] = c;
    result[6] = 0;
    result[7] = 0;
    result[8] = 0;
    result[9] = 0;
    result[10] = 1;
    result[11] = 0;
    result[12] = 0;
    result[13] = 0;
    result[14] = 0;
    result[15] = 1;
    return result;
  }

  /** ECEF `{x, y, z}` positions as the renderer's own: plain copies. */
  function _rendererPositions(positions) {
    return positions.map((p) => ({ x: p.x, y: p.y, z: p.z }));
  }

  /** The frame the tick last ran in, the tracked sample's cache key. */
  function _drawnFrameNumber() {
    return renderedFrame;
  }

  /** Make the sets the dots, the tracked dot and the rings draw in. */
  function _attach(viewer) {
    _attachTo(drawOf(viewer));
  }

  /** Make the layer's sets on `draw`, a draw port. */
  function _attachTo(draw) {
    if (sets) _detach();
    const prefix = `satellites:${++instances}`;
    pointsShown = true;
    sets = {
      points: draw.points({ id: `${prefix}:points`, show: pointsShown }),
      tracked: draw.points({ id: `${prefix}:tracked` }),
      // Ring clicks fall through to the satellites and the deselect.
      rings: draw.lines({ id: `${prefix}:rings`, pickable: false }),
    };
    layerState._sets = sets;
    dirty.clear();
    gone.clear();
    cleared = false;
    // Dots kept while detached draw once attached.
    for (const noradId of layerState._points.keys()) dirty.add(noradId);
  }

  /** Dispose of the sets; the dots and rings go with them. */
  function _detach(viewer) {
    if (!sets) return;
    sets.points.dispose();
    sets.tracked.dispose();
    sets.rings.dispose();
    sets = null;
    layerState._sets = null;
    trackedDot = null;
    dirty.clear();
    gone.clear();
    cleared = false;
  }

  /** Whether there is a set to draw satellites in. */
  function _hasPointCollection() {
    return Boolean(sets);
  }

  /** Whether the satellite dots are shown. */
  function _pointsShown() {
    return Boolean(sets) && pointsShown;
  }

  function _setPointsShown(show) {
    if (!sets) return;
    pointsShown = show;
    sets.points.show = show;
  }

  /** Show or hide every ring. */
  function _setOrbitPathsShown(show) {
    const changed = [];
    for (const path of layerState._orbitPaths.values()) {
      path.item.show = show;
      changed.push(path.item);
    }
    if (sets && changed.length) sets.rings.upsert(changed);
  }

  function _setOrbitPathShown(noradId, show) {
    const path = layerState._orbitPaths.get(noradId);
    if (!path) return;
    path.item.show = show;
    sets?.rings.upsert([path.item]);
  }

  /** Remove every orbit ring. */
  function _clearOrbitPaths() {
    const ids = [...layerState._orbitPaths.values()].map(
      (path) => path.item.id,
    );
    layerState._orbitPaths.clear();
    if (sets && ids.length) sets.rings.remove(ids);
  }

  /** Note a dot's change, sent at the end of the frame's tick. */
  function _markDirty(noradId) {
    gone.delete(noradId);
    dirty.add(noradId);
  }

  /** Send the dots changed since the last frame to the points set. */
  function _flushPoints() {
    if (!sets) return;
    if (cleared) {
      cleared = false;
      gone.clear();
      dirty.clear();
      sets.points.set([...layerState._points.values()]);
      return;
    }
    if (gone.size) {
      sets.points.remove([...gone].map(String));
      gone.clear();
    }
    if (dirty.size) {
      const items = [];
      for (const noradId of dirty) {
        const item = layerState._points.get(noradId);
        if (item) items.push(item);
      }
      dirty.clear();
      if (items.length) sets.points.upsert(items);
    }
  }

  /**
   * Draw one satellite's dot.
   * @param {number} noradId
   * @param {{x: number, y: number, z: number}} position ECEF metres.
   * @param {object} style A `POINT_STYLES` entry.
   */
  function _addPoint(noradId, position, style) {
    layerState._points.set(noradId, {
      id: String(noradId),
      pos: { x: position.x, y: position.y, z: position.z },
      pixelSize: style.pixelSize,
      color: style.color,
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
      scaleByDistance: POINT_SCALE_BY_DISTANCE,
      disableDepthTest: 0,
      show: true,
      meta: { noradId },
    });
    _markDirty(noradId);
  }

  /** Move a drawn dot to ECEF `position`; false when it has none. */
  function _movePoint(noradId, position) {
    const point = layerState._points.get(noradId);
    if (!point) return false;
    point.pos.x = position.x;
    point.pos.y = position.y;
    point.pos.z = position.z;
    _markDirty(noradId);
    return true;
  }

  function _removePoint(noradId) {
    if (!layerState._points.delete(noradId)) return;
    dirty.delete(noradId);
    if (!cleared) gone.add(noradId);
  }

  /** Remove every dot. */
  function _clearPoints() {
    layerState._points.clear();
    dirty.clear();
    gone.clear();
    cleared = true;
  }

  /** Where a dot is drawn (ECEF), or null. */
  function _pointPosition(noradId) {
    return layerState._points.get(noradId)?.pos || null;
  }

  /** Hide a dot while the tracked dot draws it. */
  function _hidePoint(noradId) {
    const point = layerState._points.get(noradId);
    if (!point) return;
    point.show = false;
    _markDirty(noradId);
  }

  /** Show a dot again in its group's style (WS-D3). */
  function _restorePoint(noradId, style) {
    const point = layerState._points.get(noradId);
    if (!point) return;
    point.show = true;
    point.pixelSize = style.pixelSize;
    point.color = style.color;
    point.outlineColor = style.outlineColor;
    point.outlineWidth = style.outlineWidth;
    point.disableDepthTest = 0;
    _markDirty(noradId);
  }

  /**
   * Draw the tracked satellite's dot and make the carrier the follow target
   * and the tracked card read (its entity record holds the card).
   * @param {{position: () => object, viewFrom: {x: number, y: number,
   *   z: number}}} options `position` is read as the follow camera reads
   *   it, once each frame before the tick moves the sample on.
   * @returns {object} The carrier.
   */
  function _addTrackedEntity({ position }) {
    const noradId = layerState._trackedNorad;
    const carrier = { noradId };
    trackedDot = {
      position,
      item: {
        id: String(noradId),
        pos: { x: 0, y: 0, z: 0 },
        ...TRACKED_DOT,
        meta: { noradId },
      },
      drawn: false,
    };
    // Drawn from the next frame's tick on, as the camera first frames it.
    return carrier;
  }

  function _removeTrackedEntity() {
    if (trackedDot?.drawn) sets?.tracked.clear();
    trackedDot = null;
  }

  /** Put the tracked dot where the tracker says it is now. */
  function _drawTrackedDot() {
    if (!trackedDot || !sets) return;
    const at = trackedDot.position();
    if (!at) return;
    const pos = trackedDot.item.pos;
    pos.x = at.x;
    pos.y = at.y;
    pos.z = at.z;
    sets.tracked.upsert([trackedDot.item]);
    trackedDot.drawn = true;
  }

  /** Whether a click's draw hit is the tracked satellite's dot. */
  function _hitIsTracked(hit) {
    return Boolean(sets) && hit?.set === sets.tracked.id;
  }

  /** The NORAD id of the satellite dot a click's draw hit is on, or null. */
  function _hitPointId(hit) {
    if (!sets || hit?.set !== sets.points.id) return null;
    const noradId = Number(hit.id);
    return Number.isFinite(noradId) ? noradId : null;
  }

  /** Publish the tracked satellite's focus rectangle from its cached position. */
  function _publishTrackedFocus(target) {
    publishFocusTargetAt({ ...target, viewer: layerState._viewer });
  }

  /** A ring's positions rotated from its bake-time frame to `gmst`'s. */
  function _ringPositions(path, gmst) {
    const angle = -(gmst - path.gmstAtBake);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const base = path.base;
    const out = new Float64Array(base.length * 3);
    for (let i = 0; i < base.length; i++) {
      const p = base[i];
      out[i * 3] = c * p.x - s * p.y;
      out[i * 3 + 1] = s * p.x + c * p.y;
      out[i * 3 + 2] = p.z;
    }
    return out;
  }

  /**
   * Show orbital path for a satellite: the ring over one orbit, baked once
   * in ECEF at the current GMST, bright in front of the globe and dimmed
   * behind it (`depthFailColor`), and turned with the Earth each
   * `RING_ROTATION_MS` (`_updateOrbitPathRotations`).
   */

  function _showOrbitPath(noradId, color) {
    if (layerState._orbitPaths.has(noradId)) return; // already showing

    const sat = layerState._catalog.get(noradId);
    if (!sat || !layerState._viewer) return;

    const bakeDate = new Date();
    const base = parts.orbits.computeOrbitPath(sat.satrec, bakeDate);
    if (base.length < 2) return;

    const pathColor = color || DEFAULT_RING_COLOR;
    const path = {
      base,
      // Same Date object as computeOrbitPath's internal fixedGmst → identical
      // GMST value (gstime is pure), so the ring starts unturned.
      gmstAtBake: gstime(bakeDate),
      item: null,
    };
    path.item = {
      id: String(noradId),
      positions: _ringPositions(path, path.gmstAtBake),
      widthPx: noradId === ISS_NORAD ? 2.5 : 2.0,
      // Along the ellipsoid between samples, as the ring always ran.
      mode: 'geodesic',
      style: { kind: 'solid', color: withAlpha(pathColor, RING_ALPHA) },
      depthFailColor: withAlpha(pathColor, RING_BEHIND_ALPHA),
      show: true,
    };
    layerState._orbitPaths.set(noradId, path);
    sets?.rings.upsert([path.item]);
  }

  /**
   * Turn every baked orbit ring from its bake-time ECEF snapshot to current
   * GMST (WS-D1). The baked ring is an inertial-frame snapshot frozen at
   * gmstAtBake; the live dot lives in true rotating-frame ECEF, so without this
   * the dot slides west off the ring at Earth-rotation rate (~0.25°/min).
   *
   * Sign derivation: a point fixed in inertial space keeps its right ascension
   * α, so its ECEF longitude λ = α − gmst DECREASES by ΔGMST as time advances
   * (it drifts WEST). A rotation about Z by θ INCREASES longitude by θ — so
   * the baked points are rotated by −ΔGMST. Mental check: ISS baked over
   * Austin at t0; 10 min later Austin has rotated east under the (inertial)
   * ring, so the ring must sit further WEST in ECEF.
   *
   * Wraparound: gstime returns radians in [0, 2π), so the raw difference can be
   * off from the continuous ΔGMST — but only by exact multiples of 2π, which a
   * rotation cannot distinguish. Tiny negative deltas right after bake are
   * likewise harmless. No unwrapping needed.
   *
   * No SGP4 here: WGS84 is rotationally symmetric about Z, so rotating the
   * baked curve rigidly equals rebaking from rotated points. A ring with a
   * `depthFailColor` is built at once where it now runs, so it never blinks.
   * @param {Date} nowDate Epoch used for current GMST.
   */

  function _updateOrbitPathRotations(nowDate) {
    if (layerState._orbitPaths.size === 0) return;
    const gmst = gstime(nowDate);
    const changed = [];
    for (const path of layerState._orbitPaths.values()) {
      path.item.positions = _ringPositions(path, gmst);
      changed.push(path.item);
    }
    sets?.rings.upsert(changed);
  }

  /**
   * Remove orbital path for a satellite.
   */

  function _hideOrbitPath(noradId) {
    const path = layerState._orbitPaths.get(noradId);
    if (!path) return;
    layerState._orbitPaths.delete(noradId);
    sets?.rings.remove([path.item.id]);
  }

  /**
   * Propagate all CORE satellite positions and update their dots.
   * (~840 sats ≈ 1.6 ms/pass — fine at the 1s/200ms cadence.) Dense extras are
   * excluded: they refresh on the round-robin budget in _propagateDenseChunk.
   */

  function _propagateAll() {
    const now = new Date();
    let updated = 0;

    for (const [noradId, sat] of layerState._catalog) {
      if (sat.group === 'dense') continue;
      const pos = parts.orbits.propagatePosition(sat.satrec, now);
      if (!pos) continue;

      const point = layerState._points.get(noradId);
      if (point) {
        fromDegreesInto(pos.longitude, pos.latitude, pos.altitude, point.pos);
        _markDirty(noradId);
        updated++;
      }
    }

    return updated;
  }

  /**
   * Shared preRender tick (single definition for init + enable):
   * - the tracked dot where the follow camera put it this frame,
   * - core fleet propagation at 200ms-tracked / 1s-idle cadence,
   * - dense extras on a per-frame round-robin budget,
   * - tracked satellite's dot sample per frame (WS-D2),
   * - orbit ring GMST re-alignment every ~1s (WS-D1),
   * - the frame's dot changes sent to the points set.
   * @param {{frame: number}} [t] The frame port's tick.
   */

  function _preRenderTick(t) {
    if (layerState._enabled) _tick();
    // The frame's sample is taken from here on (the tracked dot above was
    // drawn from the last one, as the camera framed it).
    renderedFrame = Number.isFinite(t?.frame) ? t.frame : renderedFrame + 1;
    if (layerState._enabled) _tickAfterFrame();
    _flushPoints();
  }

  /** The tick's part read before the frame's own sample is taken. */
  function _tick() {
    // The tracked dot draws at the sample the follow camera framed this frame.
    // With no camera reading it this frame, it is drawn after the frame's own
    // sample instead, so the tracked satellite is propagated once a frame.
    trackedDrawnThisTick = false;
    if (
      layerState._trackedNorad !== null &&
      layerState._trackedFrameGeo !== null &&
      layerState._trackedFrameNumber === renderedFrame
    ) {
      _drawTrackedDot();
      trackedDrawnThisTick = true;
    }
  }

  /** The tick's part that takes the frame's own sample. */
  function _tickAfterFrame() {
    const now = focusNowMs(Date.now());

    const interval = layerState._trackedNorad ? 200 : POSITION_UPDATE_MS;
    // Space Missions keeps this layer enabled for TLE lookup while deliberately
    // hiding its standalone fleet. Do not rebuild hidden point buffers on the
    // one-second propagation cadence: that GPU upload presented as a periodic
    // whole-globe pulse even though the camera remained stationary.
    if (
      layerState._params.showPoints &&
      now - layerState._lastPropagation >= interval
    ) {
      _propagateAll();
      layerState._lastPropagation = now;
    }

    if (layerState._params.showPoints) parts.catalog._propagateDenseChunk();

    // Keep the tracked satellite's (hidden) dot on the per-frame epoch shared
    // with label + camera — runs after _propagateAll so the per-frame sample
    // wins over the 200ms one.
    if (layerState._trackedNorad !== null) {
      const pos = parts.tracking._getTrackedFramePosition();
      if (pos && layerState._points.has(layerState._trackedNorad))
        _movePoint(layerState._trackedNorad, layerState._trackedFrameCartesian);
      if (!trackedDrawnThisTick) _drawTrackedDot();
    }

    _updatePointFocus(now);

    // Hidden standalone orbit rings do not need turning while Space Missions
    // draws the selected mission orbit itself.
    if (
      layerState._params.showOrbits &&
      now - layerState._lastRingRotation >= RING_ROTATION_MS
    ) {
      _updateOrbitPathRotations(new Date(now));
      layerState._lastRingRotation = now;
    }
  }

  /** Focus alpha for satellite points, inside the existing shared preRender tick. */

  // The focus pass projects every dot in one call, into buffers kept between
  // passes, so a pass over thousands of dots allocates nothing per dot.
  let focusSource = new Float64Array(0);
  let focusScreen = new Float32Array(0);
  const focusOrder = [];
  const focusScreenXY = { x: 0, y: 0 };
  function _updatePointFocus(nowMs) {
    const target = getFocusTarget();
    if (
      !layerState._params.showPoints ||
      !focusPassIsNeeded(target, layerState._activeFocusCount)
    )
      return;
    if (nowMs - layerState._lastFocusUpdate < 80) return;
    layerState._lastFocusUpdate = nowMs;
    const query = findQuery(layerState._viewer);
    const eye = findCamera(layerState._viewer)?.pose()?.position;
    if (!query || !eye) return;
    const count = layerState._points.size;
    if (focusSource.length < count * 3) {
      focusSource = new Float64Array(count * 3);
      focusScreen = new Float32Array(count * 2);
    }
    focusOrder.length = 0;
    for (const point of layerState._points.values()) {
      const pos = point?.pos;
      const i = focusOrder.length * 3;
      focusSource[i] = pos ? pos.x : NaN;
      focusSource[i + 1] = pos ? pos.y : NaN;
      focusSource[i + 2] = pos ? pos.z : NaN;
      focusOrder.push(pos);
    }
    query.projectMany(
      focusSource.subarray(0, focusOrder.length * 3),
      focusScreen,
    );
    // The pass asks in the points' own order, skipping some: a cursor finds
    // each asked position in one sweep.
    let cursor = 0;
    const result = applySatellitePointFocusDeemphasis({
      points: layerState._points,
      trackedId: layerState._trackedNorad,
      target,
      previousActiveCount: layerState._activeFocusCount,
      nowMs,
      screenPositionFor: (position) => {
        while (cursor < focusOrder.length && focusOrder[cursor] !== position)
          cursor++;
        if (cursor >= focusOrder.length) {
          cursor = 0;
          return query.project(position);
        }
        const x = focusScreen[cursor * 2];
        const y = focusScreen[cursor * 2 + 1];
        if (Number.isNaN(x) || Number.isNaN(y)) return null;
        focusScreenXY.x = x;
        focusScreenXY.y = y;
        return focusScreenXY;
      },
      cameraDistanceFor: (position) => distance(eye, position),
      baseColorFor: (noradId) =>
        parts.controls._pointStyleFor(
          noradId,
          layerState._catalog.get(noradId)?.group,
        ).color,
    });
    layerState._activeFocusCount = result.activeCount;
  }

  /**
   * Apply the gated satellite-point focus pass through the production color path.
   * @param {object} input
   * @param {Map<number, object>} input.points Point items by NORAD id; a
   *   written colour is sent to the set with the frame's other changes.
   * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
   */

  function applySatellitePointFocusDeemphasis({
    points,
    trackedId,
    target,
    previousActiveCount = 0,
    nowMs,
    screenPositionFor,
    cameraDistanceFor,
    baseColorFor,
    params,
  }) {
    if (!focusPassIsNeeded(target, previousActiveCount)) {
      return { writes: 0, transitioning: false, activeCount: 0, ran: false };
    }
    let writes = 0;
    let transitioning = false;
    let activeCount = 0;
    for (const [noradId, point] of points || []) {
      if (noradId === trackedId || !point?.pos) continue;
      const cameraDistance = cameraDistanceFor(point.pos);
      const distanceScale = nearFarScalarValueAtDistance(
        point.scaleByDistance,
        cameraDistance,
      );
      const halfExtentPx = (point.pixelSize || 5) * distanceScale * 0.5;
      const focus = advanceSpriteFocus(point, {
        // Hidden points still release toward identity, preventing stale dim
        // alpha if a catalog/presentation toggle later makes them visible.
        screenPosition:
          point.show === false ? null : screenPositionFor(point.pos),
        cameraDistance,
        nowMs,
        target,
        params,
        spriteHalfWidthPx: halfExtentPx,
        spriteHalfHeightPx: halfExtentPx,
      });
      transitioning ||= focus.transitioning;
      if (focus.active) activeCount += 1;
      const base = baseColorFor(noradId);
      const alpha = base[3] * focus.factor;
      if (focusAlphaNeedsWrite(point.color?.[3], alpha, params)) {
        // Point stays continuously present at the non-zero emphasis floor; its
        // own alpha yields around the tracked target, independent of draw order.
        point.color = withAlpha(base, alpha);
        if (points === layerState._points) _markDirty(noradId);
        writes += 1;
      }
    }
    return { writes, transitioning, activeCount, ran: true };
  }
  return {
    orbitFrameModelMatrix,
    _rendererPositions,
    _drawnFrameNumber,
    _attach,
    _attachTo,
    _detach,
    _hasPointCollection,
    _pointsShown,
    _setPointsShown,
    _setOrbitPathsShown,
    _setOrbitPathShown,
    _clearOrbitPaths,
    _addPoint,
    _movePoint,
    _removePoint,
    _clearPoints,
    _pointPosition,
    _hidePoint,
    _restorePoint,
    _addTrackedEntity,
    _removeTrackedEntity,
    _publishTrackedFocus,
    _hitIsTracked,
    _hitPointId,
    _showOrbitPath,
    _updateOrbitPathRotations,
    _hideOrbitPath,
    _propagateAll,
    _preRenderTick,
    _updatePointFocus,
    applySatellitePointFocusDeemphasis,
    _flushPoints,
  };
}
