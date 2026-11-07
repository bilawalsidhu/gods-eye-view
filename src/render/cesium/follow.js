/**
 * @module render/cesium/follow
 * @description The Cesium camera port's follow. It is Cesium's own entity
 * tracking (`trackedEntity` and its EntityView) on a hidden helper entity
 * per target, so the camera behaves as it does for any tracked entity:
 * the user orbits and zooms around the target, tilt is off, and `moveEnd`
 * waits. On top of it, a target with a `minRange` gets GEV's close-range
 * rules: an exact first framing, no zoom coasting, a zoom floor, and an eye
 * that never crosses through the target.
 *
 * Whatever sets Cesium's `trackedEntity` takes the camera, so a follow ends
 * when anything else is tracked, and `follow(null)` ends any tracking.
 * `autodetect` is Cesium's AUTODETECT frame: a frame from inertial motion
 * (x forward, y left, z up) for a fast target such as a satellite, ENU for
 * a slow or still one. It is not the stub's frame along the ground track,
 * so an autodetect `viewFrom` is renderer-specific.
 */
import * as Cesium from 'cesium';
import { toCartesian } from './common.js';
import { trackedEntityViewEntity } from './internals.js';

/** Frames to wait for a target's first position before giving up framing. */
const MAX_FRAME_ATTEMPTS = 120;
const TRANSPARENT = new Cesium.Color(0, 0, 0, 0);
const ZOOM_STATES = new WeakMap();
/** Each helper entity's FollowTarget. */
const HELPER_TARGETS = new WeakMap();

/**
 * A pick as the follow's helper entity should not make it: a hit on a helper
 * is a hit on its target's drawn `entity`, or no hit when it has none. Any
 * other pick comes back as it was.
 * @param {object|undefined} picked What `scene.pick` or `drillPick` gave.
 * @returns {object|undefined}
 */
export function pickThroughFollowHelper(picked) {
  const target = picked?.id && HELPER_TARGETS.get(picked.id);
  if (!target) return picked;
  return target.entity ? { ...picked, id: target.entity } : undefined;
}

/**
 * Turn zoom coasting off and raise the zoom floor to `minRange` while any
 * owner holds it; the last release restores the controller's own values.
 * @param {object|undefined} controller A ScreenSpaceCameraController.
 * @param {object} owner
 * @param {number} minRange
 * @returns {() => void} Release.
 */
export function holdFollowZoom(controller, owner, minRange) {
  if (!controller) return () => {};
  let state = ZOOM_STATES.get(controller);
  if (!state) {
    state = {
      inertiaZoom: controller.inertiaZoom,
      minimumZoomDistance: controller.minimumZoomDistance,
      owners: new Map(),
    };
    ZOOM_STATES.set(controller, state);
  }
  state.owners.set(owner, minRange);
  applyFollowZoom(controller, state);
  return () => {
    const current = ZOOM_STATES.get(controller);
    if (!current?.owners.delete(owner)) return;
    if (current.owners.size > 0) {
      applyFollowZoom(controller, current);
      return;
    }
    controller.inertiaZoom = current.inertiaZoom;
    controller.minimumZoomDistance = current.minimumZoomDistance;
    ZOOM_STATES.delete(controller);
  };
}

/**
 * The controller's own zoom coast or zoom floor: while a follow holds them,
 * the value it gives back on release, not the one in force.
 * @param {object} controller A ScreenSpaceCameraController.
 * @param {'inertiaZoom'|'minimumZoomDistance'} key
 * @returns {number}
 */
export function followZoomBase(controller, key) {
  const state = ZOOM_STATES.get(controller);
  return state ? state[key] : controller[key];
}

/**
 * Set the controller's own zoom coast or zoom floor. While a follow holds
 * them it is what the follow gives back on release, and a zoom floor above
 * the follow's holds takes effect at once.
 * @param {object} controller A ScreenSpaceCameraController.
 * @param {'inertiaZoom'|'minimumZoomDistance'} key
 * @param {number} value
 */
export function setFollowZoomBase(controller, key, value) {
  const state = ZOOM_STATES.get(controller);
  if (!state) {
    controller[key] = value;
    return;
  }
  state[key] = value;
  applyFollowZoom(controller, state);
}

function applyFollowZoom(controller, state) {
  // The hold's coast is Cesium's shortest coefficient, 0; a controller of
  // its own already coasting less (1 or more is no coast, under 0 is faster
  // decay) keeps its own.
  const own = state.inertiaZoom;
  controller.inertiaZoom = own >= 1 || own < 0 ? own : 0;
  controller.minimumZoomDistance = Math.max(
    state.minimumZoomDistance,
    ...state.owners.values(),
  );
}

/**
 * Keep a follow-frame eye on the same side of its target and at least
 * `minimumRangeM` from it, in front and in all.
 * @param {{position: Cesium.Cartesian3, direction: Cesium.Cartesian3}} camera
 *   Eye in the follow frame; corrected in place.
 * @param {Cesium.Cartesian3} previousPosition The eye's last frame.
 * @param {number} minimumRangeM
 * @returns {boolean} Whether the eye was corrected.
 */
export function clampFollowEye(camera, previousPosition, minimumRangeM) {
  const crossedOrigin =
    Cesium.Cartesian3.dot(camera.position, previousPosition) <= 0;
  const forwardDistance = -Cesium.Cartesian3.dot(
    camera.position,
    camera.direction,
  );
  const rangeSquared = Cesium.Cartesian3.magnitudeSquared(camera.position);
  if (crossedOrigin) {
    Cesium.Cartesian3.normalize(previousPosition, camera.position);
    Cesium.Cartesian3.multiplyByScalar(
      camera.position,
      minimumRangeM,
      camera.position,
    );
    return true;
  }
  if (
    forwardDistance < minimumRangeM ||
    rangeSquared < minimumRangeM * minimumRangeM
  ) {
    Cesium.Cartesian3.multiplyByScalar(
      camera.direction,
      -minimumRangeM,
      camera.position,
    );
    return true;
  }
  return false;
}

const gregorianScratch = new Cesium.GregorianDate();
/**
 * Scene time in epoch ms, sub-millisecond included: `JulianDate.toDate`
 * drops the fraction, and EntityView samples motion 1 ms apart.
 */
function msOf(time) {
  const g = Cesium.JulianDate.toGregorianDate(time, gregorianScratch);
  const second = g.isLeapSecond ? g.second - 1 : g.second;
  return (
    Date.UTC(g.year, g.month - 1, g.day, g.hour, g.minute, second) +
    g.millisecond
  );
}

/**
 * The eye's starting offset: `viewFrom`, put out to the target's minimum
 * range. Cesium's EntityView frames from it too, so the two agree.
 */
function startOffset(target, viewFrom, result) {
  const offset = Cesium.Cartesian3.fromElements(
    viewFrom.x,
    viewFrom.y,
    viewFrom.z,
    result,
  );
  const range = Cesium.Cartesian3.magnitude(offset);
  const minRange = Math.max(target.minRange ?? 0, target.boundingRadius ?? 0);
  if (range >= Cesium.Math.EPSILON6 && range < minRange)
    Cesium.Cartesian3.multiplyByScalar(offset, minRange / range, offset);
  return offset;
}

/**
 * @param {{widget: object, scene: object, camera: object,
 *   onChanged: () => void}} options `widget` is the Viewer or CesiumWidget
 *   whose `trackedEntity` this follows with; `onChanged` runs on every
 *   change of what it tracks.
 */
export function createCesiumFollow({ widget, scene, camera, onChanged }) {
  /** @type {null | {target: object, helper: object, framed: boolean,
   *   attempts: number, previous: Cesium.Cartesian3, releaseZoom: () => void}} */
  let current = null;
  let removePreUpdate = null;
  /** What `followChanged` last announced: it fires only when that changes. */
  let announced = null;
  const followed = () =>
    current && widget.trackedEntity === current.helper ? current.target : null;

  function release(entry) {
    if (!entry) return;
    entry.releaseZoom();
    if (!widget.isDestroyed?.()) widget.entities.remove(entry.helper);
    if (!current && removePreUpdate) {
      removePreUpdate();
      removePreUpdate = null;
    }
  }

  // Anything that changes what Cesium tracks (a follow, `trackedEntity`
  // set elsewhere, the helper removed) ends a follow it replaced.
  const removeChanged = widget.trackedEntityChanged.addEventListener(
    (value) => {
      if (current && value !== current.helper) {
        const ended = current;
        current = null;
        release(ended);
      }
      const now = followed();
      if (now !== announced) {
        announced = now;
        onChanged();
      }
    },
  );

  const viewFromAt = (target, time) =>
    typeof target.viewFrom === 'function'
      ? target.viewFrom(msOf(time))
      : target.viewFrom;

  function helperFor(target) {
    const helper = widget.entities.add({
      position: new Cesium.CallbackProperty((time, result) => {
        const p = target.position(msOf(time));
        return p ? Cesium.Cartesian3.fromElements(p.x, p.y, p.z, result) : p;
      }, false),
      // EntityView tracks an entity only once its bounding sphere is
      // ready, and an entity without graphics has none.
      // Outline too: Cesium blends an opaque default outline into the edge.
      point: {
        pixelSize: 1,
        color: TRANSPARENT,
        outlineColor: TRANSPARENT,
        outlineWidth: 0,
      },
      viewFrom: new Cesium.CallbackProperty((time, result) => {
        const v = viewFromAt(target, time);
        return v ? startOffset(target, v, result) : v;
      }, false),
      trackingReferenceFrame:
        target.frame === 'autodetect'
          ? Cesium.TrackingReferenceFrame.AUTODETECT
          : Cesium.TrackingReferenceFrame.ENU,
    });
    HELPER_TARGETS.set(helper, target);
    return helper;
  }

  // preUpdate on purpose: in preRender the target's drawing is already
  // prepared, so moving the eye there parts it from the target for a frame.
  function step() {
    const entry = current;
    if (!entry || entry.gaveUp || widget.trackedEntity !== entry.helper) return;
    if (!entry.framed) frame(entry);
    else if (
      entry.target.minRange > 0 &&
      clampFollowEye(camera, entry.previous, entry.target.minRange)
    )
      camera.lookAtTransform(
        camera.transform,
        Cesium.Cartesian3.clone(camera.position),
      );
    if (entry.framed) Cesium.Cartesian3.clone(camera.position, entry.previous);
  }

  /**
   * The first framing. Cesium's EntityView keeps the old eye when tracking
   * switches across a large distance, so an ENU follow places it exactly;
   * an autodetected frame is Cesium's own to place.
   */
  function frame(entry) {
    const { target } = entry;
    entry.attempts += 1;
    const time = widget.clock.currentTime;
    const at = target.position(msOf(time));
    if (target.frame !== 'enu') {
      // Framed once Cesium's EntityView has taken the helper on: until
      // then the camera may still ride the previous tracking's frame.
      entry.framed = trackedEntityViewEntity(widget) === entry.helper;
      if (!entry.framed) giveUpAfterWaiting(entry);
      return;
    }
    const viewFrom = at && viewFromAt(target, time);
    if (!at || !viewFrom) {
      giveUpAfterWaiting(entry);
      return;
    }
    const offset = startOffset(target, viewFrom);
    if (Cesium.Cartesian3.magnitude(offset) < Cesium.Math.EPSILON6) {
      // No offset to frame at: Cesium's own framing stands, unpoliced.
      giveUp(entry);
      return;
    }
    camera.lookAtTransform(
      Cesium.Transforms.eastNorthUpToFixedFrame(
        toCartesian(at),
        Cesium.Ellipsoid.WGS84,
      ),
      offset,
    );
    entry.framed = true;
  }

  /**
   * With no position to frame for MAX_FRAME_ATTEMPTS frames, the follow
   * leaves the camera to Cesium: no framing, no zoom hold, no clamp.
   */
  function giveUpAfterWaiting(entry) {
    if (entry.attempts >= MAX_FRAME_ATTEMPTS) giveUp(entry);
  }
  function giveUp(entry) {
    entry.gaveUp = true;
    entry.releaseZoom();
  }

  return {
    /** @param {object|null} target A contract FollowTarget. */
    follow(target) {
      const previous = current;
      if (!target) {
        current = null;
        widget.trackedEntity = undefined;
        release(previous);
        return;
      }
      const entry = {
        target,
        helper: helperFor(target),
        framed: false,
        gaveUp: false,
        attempts: 0,
        previous: new Cesium.Cartesian3(),
        releaseZoom: () => {},
      };
      if (target.minRange > 0)
        entry.releaseZoom = holdFollowZoom(
          scene.screenSpaceCameraController,
          entry,
          target.minRange,
        );
      current = entry;
      removePreUpdate ??= scene.preUpdate.addEventListener(step);
      widget.trackedEntity = entry.helper;
      release(previous);
    },
    get followed() {
      return followed();
    },
    get followFramed() {
      return Boolean(current?.framed);
    },
    followOffset: Object.freeze({
      get() {
        if (!current?.framed) return null;
        const p = camera.position;
        return { x: p.x, y: p.y, z: p.z };
      },
      set(offset) {
        if (!current?.framed) return;
        camera.lookAtTransform(camera.transform, toCartesian(offset));
        Cesium.Cartesian3.clone(camera.position, current.previous);
        scene.requestRender();
      },
    }),
    dispose() {
      removeChanged();
      const ended = current;
      current = null;
      if (ended && !widget.isDestroyed?.()) {
        if (widget.trackedEntity === ended.helper)
          widget.trackedEntity = undefined;
      }
      release(ended);
      removePreUpdate?.();
      removePreUpdate = null;
    },
  };
}
