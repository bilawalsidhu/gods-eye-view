import * as geo from '../geo/index.js';
import { isPickedWorldPosition } from '../data/scenePick.js';
import { t } from '../i18n/index.js';

// The camera is the globe engine's, and so is the follow. On Cesium the
// follow is the viewer's tracked entity (an app entity, or the proxy of an
// engine follow): its EntityView keeps whatever offset the camera takes in
// the entity's frame. Elsewhere the follow owns its offset.

// Cesium's EasingFunction.CUBIC_IN_OUT (tween.js Cubic.InOut).
function cubicInOut(amount) {
  if ((amount *= 2) < 1) return 0.5 * amount * amount * amount;
  return 0.5 * ((amount -= 2) * amount * amount + 2);
}

function followedEntity(engine, viewer) {
  return engine?.camera.following?.() ? (viewer?.trackedEntity ?? null) : null;
}

// A follow handle that takes a new offset without ending the follow.
function engineFollow(engine, viewer) {
  const handle = engine?.camera.following?.();
  return handle &&
    !followedEntity(engine, viewer) &&
    typeof handle.target === 'function' &&
    typeof handle.retarget === 'function'
    ? handle
    : null;
}

function trackedTarget(entity, viewer) {
  // Read the visual's sample first; sampling a flight CallbackProperty twice
  // can advance dead reckoning ahead of the displayed aircraft.
  return (
    entity?.gevDisplayPosition?.() ||
    entity?.position?.getValue(viewer?.clock?.currentTime)
  );
}

export const OBLIQUE_PITCH = geo.math.toRadians(-35);
export const STRAIGHT_DOWN_PITCH = geo.math.toRadians(-89);
const OBLIQUE_THRESHOLD = geo.math.toRadians(-60);

function normalizedHeading(heading) {
  const wrapped = geo.math.zeroToTwoPi(Number.isFinite(heading) ? heading : 0);
  return Math.abs(wrapped - geo.math.TWO_PI) < geo.math.EPSILON10 ? 0 : wrapped;
}

/**
 * Return the world position under the center of the canvas, when available.
 * @param {import('../globe/contract.js').GlobeEngine | null} engine
 */
export function pickViewTarget(engine) {
  if (!engine) return null;
  const { width, height } = engine.host.size();
  if (!width || !height) return null;
  const center = { x: width / 2, y: height / 2 };
  const { picker, camera } = engine;
  // Depth first, then terrain before the ellipsoid: the globe pick
  // intersects the rendered surface, so over keyless elevated terrain it
  // returns the ground the operator is looking at. pickEllipsoid answers with
  // sea level, which on a plateau sits far below the view and would swing the
  // camera on every tilt.
  const stages = [
    () =>
      picker.pickPositionSupported ? picker.pickPosition(center) : undefined,
    () => picker.pickGlobe(center),
    () => camera.pickEllipsoid(center),
  ];
  for (const stage of stages) {
    let picked = null;
    try {
      picked = stage();
    } catch {
      picked = null;
    }
    if (isPickedWorldPosition(picked)) return picked;
  }
  return null;
}

/**
 * Describe the camera as an orbit around the current viewport center.
 * @param {import('../globe/contract.js').GlobeEngine | null} engine
 * @param {object | null} [viewer] The Cesium viewer: its tracked entity and
 *   the clock that samples it.
 */
export function readCameraTargetFrame(engine, viewer = null) {
  if (!engine) return null;
  const entity = followedEntity(engine, viewer);
  const follow = engineFollow(engine, viewer);
  const center = entity
    ? trackedTarget(entity, viewer)
    : (follow?.target() ?? pickViewTarget(engine));
  const pose = engine.camera.pose();
  if (!center || !isPickedWorldPosition(pose.position)) return null;

  const transform = geo.transforms.eastNorthUpToFixedFrame(center);
  const inverse = geo.matrix4.inverseTransformation(
    transform,
    geo.matrix4.create(),
  );
  const localOffset = geo.matrix4.multiplyByPoint(
    inverse,
    pose.position,
    geo.cartesian3.create(),
  );
  const range = geo.cartesian3.magnitude(localOffset);
  if (!Number.isFinite(range) || range < 1) return null;

  const pitch = -Math.asin(geo.math.clamp(localOffset.z / range, -1, 1));
  // Cesium places a lookAt camera at range * (-sin h cos p, -cos h cos p,
  // -sin p) in the target's east-north-up frame, so recovering h means
  // negating BOTH horizontal components. Negating only the north one reads
  // every heading as its mirror image (30 deg comes back as 330), which would
  // make north-up rotate the wrong way from three quarters of the compass.
  const targetHeading = Math.atan2(-localOffset.x, -localOffset.y);
  const heading = normalizedHeading(
    pitch < geo.math.toRadians(-88.5) ? pose.heading : targetHeading,
  );
  return { target: center, range, heading, pitch };
}

/**
 * Apply an orbit frame, then return the camera to the fixed-world frame.
 * @param {import('../globe/contract.js').GlobeEngine | null} engine
 * @param {object} frame From {@link readCameraTargetFrame}.
 * @param {object | null} [viewer] As in readCameraTargetFrame.
 */
function setCameraTargetFrame(engine, frame, viewer = null) {
  if (!engine || !frame?.target || !Number.isFinite(frame.range)) return false;
  const { camera } = engine;
  // Inside an engine's own follow: the new frame is the follow's offset (a
  // camera command would end the follow).
  const follow = engineFollow(engine, viewer);
  if (follow) {
    const heading = normalizedHeading(frame.heading);
    const flat = Math.cos(frame.pitch);
    follow.retarget({
      viewFrom: geo.cartesian3.create(
        -frame.range * Math.sin(heading) * flat,
        -frame.range * Math.cos(heading) * flat,
        -frame.range * Math.sin(frame.pitch),
      ),
    });
    engine.render.request('camera-orientation');
    return true;
  }
  try {
    const offset = {
      heading: normalizedHeading(frame.heading),
      pitch: frame.pitch,
      range: frame.range,
    };
    if (followedEntity(engine, viewer)) {
      // lookAt is a camera command and would end an engine follow; the same
      // frame through lookAtTransform does not. Then back to EntityView's
      // reference frame (including satellite frames): its next update
      // carries this new local offset along with the target.
      const trackedTransform = camera.transform();
      camera.lookAtTransform(
        geo.transforms.eastNorthUpToFixedFrame(frame.target),
        offset,
      );
      camera.lookAtTransform(trackedTransform);
      engine.render.request('camera-orientation');
      return true;
    }
    camera.lookAt(frame.target, offset);
    const { position: destination, direction, up } = camera.pose();
    camera.release();
    if (destination && direction && up) {
      camera.setView({ destination, orientation: { direction, up } });
    }
    engine.render.request('camera-orientation');
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the map reads as tilted, from the orbit frame.
 *
 * This is the quantity the toggle commands, so it is the only one the button
 * may show. The camera's OWN pitch is a different angle: at a few kilometres
 * the two agree to 0.02 degrees, but from the full-globe view they are tens of
 * degrees apart, because the point under the middle of the screen is most of a
 * hemisphere away. Reading the camera's pitch there made the toggle choose
 * oblique twice in a row — commanded oblique, camera pitch came back near -77,
 * still "not tilted", tilt again.
 *
 * @param {{pitch: number}|null} frame From {@link readCameraTargetFrame}.
 */
function frameIsTilted(frame) {
  const pitch = Number(frame?.pitch);
  return Number.isFinite(pitch) ? pitch > OBLIQUE_THRESHOLD : false;
}

/** Toggle between a straight-down map and a useful oblique map angle. */
export function toggleCameraTilt(engine, viewer = null) {
  const frame = readCameraTargetFrame(engine, viewer);
  if (!frame) return false;
  const tilted = frameIsTilted(frame);
  const pitch = tilted ? STRAIGHT_DOWN_PITCH : OBLIQUE_PITCH;
  return setCameraTargetFrame(engine, { ...frame, pitch }, viewer)
    ? { tilted: !tilted, pitch }
    : false;
}

/** Rotate around the viewport center until north is at the top. */
export function resetCameraNorth(engine, viewer = null) {
  const frame = readCameraTargetFrame(engine, viewer);
  if (!frame) return false;
  return setCameraTargetFrame(engine, { ...frame, heading: 0 }, viewer);
}

function headingDegrees(engine) {
  return geo.math.toDegrees(normalizedHeading(engine?.camera.pose().heading));
}

/**
 * Ease an orbit without handing off the entity that owns the follow camera.
 * @param {import('../globe/contract.js').GlobeEngine | null} engine
 * @param {{ now?: () => number, duration?: number, tracker?: object }} [options]
 *   `tracker`: the viewer, as in readCameraTargetFrame.
 */
export function createCameraOrientationAnimator(
  engine,
  { now = () => performance.now(), duration = 650, tracker = null } = {},
) {
  const viewer = tracker;
  let remove = null;
  let pending = null;
  const cancel = () => {
    remove?.();
    remove = null;
    pending = null;
  };
  function animate(frame, destination) {
    cancel();
    if (!engine) return false;
    if (duration <= 0)
      return setCameraTargetFrame(engine, { ...frame, ...destination }, viewer);
    const entity = followedEntity(engine, viewer);
    pending = destination;
    const start = now();
    const headingDelta = geo.math.negativePiToPi(
      destination.heading - frame.heading,
    );
    remove = engine.frames.preUpdate.addEventListener(() => {
      if (engine.isDestroyed() || followedEntity(engine, viewer) !== entity) {
        cancel();
        return;
      }
      const progress = geo.math.clamp((now() - start) / duration, 0, 1);
      const eased = cubicInOut(progress);
      const center = entity ? trackedTarget(entity, viewer) : frame.target;
      if (
        !isPickedWorldPosition(center) ||
        !setCameraTargetFrame(
          engine,
          {
            ...frame,
            target: center,
            heading: frame.heading + headingDelta * eased,
            pitch: geo.math.lerp(frame.pitch, destination.pitch, eased),
          },
          viewer,
        )
      ) {
        cancel();
        return;
      }
      if (progress === 1) cancel();
    });
    engine.render.request('camera-orientation');
    return true;
  }
  return {
    animate,
    cancel,
    get destination() {
      return pending;
    },
  };
}

/**
 * Bind the two map-orientation actions and keep their accessible state current.
 * @param {{
 *   engine?: import('../globe/contract.js').GlobeEngine,
 *   viewer?: object,
 *   elements: object,
 *   runNavigation: Function,
 *   showToast?: Function,
 *   animationMs?: number,
 * }} options The viewer (Cesium) is read for its tracked entity and clock.
 */
export function bindCameraOrientationControls({
  viewer = null,
  engine = null,
  publish,
  runNavigation,
  showToast,
  animationMs,
}) {
  const removers = [];
  let destroyed = false;
  // The tilt state is the one thing here that costs a depth read of the middle
  // of the screen: 4 ms median and up to 12 ms, measured on this machine. It is
  // therefore held between refreshes rather than recomputed per frame.
  let tilted = false;
  const animator = createCameraOrientationAnimator(engine, {
    tracker: viewer,
    ...(animationMs === undefined ? {} : { duration: animationMs }),
  });
  const readFrame = () => readCameraTargetFrame(engine, viewer);

  /** Recompute the tilt state exactly, paying for one pick. */
  const refreshTilt = () => {
    if (destroyed) return;
    tilted = frameIsTilted(readFrame());
    sync();
  };

  /**
   * Publish the two controls' state.
   *
   * The compass needle reads the camera's own bearing, which costs nothing, so
   * this can run on every rendered frame: measured at 1.4 ms across 120 frames
   * of a continuously dragged map (0.012 ms per frame, 0.1 ms worst case),
   * against the 4 ms per frame the depth read it replaced would have cost.
   * That measured the controls' own work; what a publish renders is the
   * view's (the globe actions compass alone renders the heading).
   */
  function sync() {
    if (destroyed) return;
    const next = {
      tilted,
      heading: Math.round(headingDegrees(engine)) % 360,
    };
    publish?.(next);
  }

  function tilt() {
    if (destroyed) return;
    const pending = animator.destination;
    const result = runNavigation('camera', () => {
      const frame = readFrame();
      if (!frame) return false;
      const nextTilted = !frameIsTilted(pending || frame);
      const pitch = nextTilted ? OBLIQUE_PITCH : STRAIGHT_DOWN_PITCH;
      return animator.animate(frame, {
        heading: pending?.heading ?? frame.heading,
        pitch,
      })
        ? { tilted: nextTilted, pitch }
        : false;
    });
    if (result) {
      showToast?.(result.tilted ? t('Tilted view') : t('Straight-down view'));
      // The action reports the state it just commanded, so the button can
      // follow it without a second pick.
      tilted = result.tilted;
    }
    sync();
  }

  function northUp() {
    if (destroyed) return;
    const pending = animator.destination;
    const result = runNavigation('camera', () => {
      const frame = readFrame();
      return (
        frame &&
        animator.animate(frame, {
          heading: 0,
          pitch: pending?.pitch ?? frame.pitch,
        })
      );
    });
    if (result) showToast?.(t('North up'));
    sync();
  }

  const subscribe = (event, handler) => {
    const remove = event?.addEventListener?.(handler);
    if (typeof remove === 'function') removers.push(remove);
  };
  // The needle follows every frame the scene draws. `camera.changed` is NOT
  // enough: it only fires past `camera.percentageChanged`, so a rotation of a
  // few degrees leaves the needle pointing at the old bearing.
  subscribe(engine?.frames.preRender, sync);
  // The exact tilt state is refreshed once per gesture, not once per frame —
  // moveEnd fires when the camera stops, which is where the pick is affordable.
  subscribe(engine?.camera.moveEnd, refreshTilt);
  subscribe(engine?.camera.followChanged, animator.cancel);
  for (const type of ['pointerdown', 'wheel']) {
    const canvas = engine?.host.canvas;
    canvas?.addEventListener?.(type, animator.cancel, { passive: true });
    removers.push(() => canvas?.removeEventListener?.(type, animator.cancel));
  }
  refreshTilt();

  return {
    tilt,
    northUp,
    sync,
    refreshTilt,
    cancel: animator.cancel,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      animator.cancel();
      for (const remove of removers.splice(0)) remove();
    },
  };
}
