import { isPickedWorldPosition } from '../data/scenePick.js';
import { t } from '../i18n/index.js';
import {
  followedOf,
  followedPosition,
  isFollowing,
  onFollowChanged,
} from '../data/followed.js';
import {
  clamp,
  eastNorthUp,
  inverseFramePoint,
  magnitude,
  negativePiToPi,
  toDegrees,
  toRadians,
  TWO_PI,
  zeroToTwoPi,
} from '../geo/index.js';
import { findCamera, findFrame, findQuery } from '../render/rendererOf.js';
import { placeFollowEye } from './shareFollow.js';

function trackedTarget(viewer) {
  // The visual's sample first: sampling a flight CallbackProperty twice can
  // advance dead reckoning ahead of the displayed aircraft.
  return followedPosition(viewer, followedOf(viewer));
}

export const OBLIQUE_PITCH = toRadians(-35);
export const STRAIGHT_DOWN_PITCH = toRadians(-89);
const OBLIQUE_THRESHOLD = toRadians(-60);
const EPSILON10 = 1e-10;

function normalizedHeading(heading) {
  const wrapped = zeroToTwoPi(Number.isFinite(heading) ? heading : 0);
  return Math.abs(wrapped - TWO_PI) < EPSILON10 ? 0 : wrapped;
}

/** The camera port's pose, or null when there is none to read. */
function poseOf(camera) {
  try {
    return camera?.pose() ?? null;
  } catch {
    return null;
  }
}

/** Cubic ease in and out, 0..1 to 0..1. */
function cubicInOut(k) {
  if (k < 0.5) return 4 * k * k * k;
  const f = 2 * k - 2;
  return 0.5 * f * f * f + 1;
}

/** Return the world position under the center of the canvas, when available. */
export function pickViewTarget(viewer) {
  const query = findQuery(viewer);
  const canvas = viewer?.scene?.canvas;
  if (!query || !canvas) return null;
  const width = canvas.clientWidth || canvas.width || 0;
  const height = canvas.clientHeight || canvas.height || 0;
  if (!width || !height) return null;
  const x = width / 2;
  const y = height / 2;
  const attempt = (pick) => {
    try {
      return pick();
    } catch {
      return null;
    }
  };
  // Depth first: what is drawn under the centre, tiles included.
  let target = attempt(() => query.pickPosition(x, y));
  // Terrain before the ellipsoid: the globe pick intersects the rendered
  // surface, so over keyless elevated terrain it returns the ground the
  // operator is looking at. The ellipsoid answers with sea level, which on a
  // plateau sits far below the view and would swing the camera on every tilt.
  if (!isPickedWorldPosition(target))
    target = attempt(() => query.pickGlobe(query.pickRay(x, y)));
  if (!isPickedWorldPosition(target))
    target = attempt(() => query.pickEllipsoid(x, y));
  return isPickedWorldPosition(target) ? target : null;
}

/** Describe the camera as an orbit around the current viewport center. */
export function readCameraTargetFrame(viewer) {
  const pose = poseOf(findCamera(viewer));
  const target = isFollowing(viewer)
    ? trackedTarget(viewer)
    : pickViewTarget(viewer);
  if (!pose || !target || !isPickedWorldPosition(pose.position)) return null;

  const localOffset = inverseFramePoint(eastNorthUp(target), pose.position);
  const range = magnitude(localOffset);
  if (!Number.isFinite(range) || range < 1) return null;

  const pitch = -Math.asin(clamp(localOffset.z / range, -1, 1));
  // A lookAt camera sits at range * (-sin h cos p, -cos h cos p, -sin p) in
  // the target's east-north-up frame, so recovering h means negating BOTH
  // horizontal components. Negating only the north one reads every heading
  // as its mirror image (30 deg comes back as 330), which would make north-up
  // rotate the wrong way from three quarters of the compass.
  const targetHeading = Math.atan2(-localOffset.x, -localOffset.y);
  const heading = normalizedHeading(
    pitch < toRadians(-88.5) ? pose.heading : targetHeading,
  );
  return { target, range, heading, pitch };
}

/** Apply an orbit frame, then return the camera to the world frame. */
function setCameraTargetFrame(viewer, frame) {
  const camera = findCamera(viewer);
  if (!camera || !frame?.target || !Number.isFinite(frame.range)) return false;
  const offset = {
    heading: normalizedHeading(frame.heading),
    pitch: frame.pitch,
    range: frame.range,
  };
  try {
    // Following keeps the follow's own frame (satellite frames included):
    // its next update carries the new offset along with the target.
    if (isFollowing(viewer))
      return placeFollowEye(viewer, frame.target, offset);
    camera.lookAt(frame.target, offset);
    const pose = camera.pose();
    camera.release();
    if (pose?.position && pose.direction && pose.up)
      camera.setView({
        destination: pose.position,
        orientation: { direction: pose.direction, up: pose.up },
      });
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
export function toggleCameraTilt(viewer) {
  const frame = readCameraTargetFrame(viewer);
  if (!frame) return false;
  const tilted = frameIsTilted(frame);
  const pitch = tilted ? STRAIGHT_DOWN_PITCH : OBLIQUE_PITCH;
  return setCameraTargetFrame(viewer, { ...frame, pitch })
    ? { tilted: !tilted, pitch }
    : false;
}

/** Rotate around the viewport center until north is at the top. */
export function resetCameraNorth(viewer) {
  const frame = readCameraTargetFrame(viewer);
  if (!frame) return false;
  return setCameraTargetFrame(viewer, { ...frame, heading: 0 });
}

function headingDegrees(viewer) {
  return toDegrees(normalizedHeading(poseOf(findCamera(viewer))?.heading));
}

/** Ease an orbit without handing off the entity that owns the follow camera. */
export function createCameraOrientationAnimator(
  viewer,
  { now = () => performance.now(), duration = 650 } = {},
) {
  let remove = null;
  let pending = null;
  const cancel = () => {
    remove?.();
    remove = null;
    pending = null;
  };
  function animate(frame, destination) {
    cancel();
    const frames = findFrame(viewer);
    if (!frames || duration <= 0)
      return setCameraTargetFrame(viewer, { ...frame, ...destination });
    const followed = followedOf(viewer);
    pending = destination;
    const start = now();
    const headingDelta = negativePiToPi(destination.heading - frame.heading);
    remove = frames.on('preUpdate', () => {
      if (viewer.isDestroyed?.() || followedOf(viewer) !== followed) {
        cancel();
        return;
      }
      const progress = clamp((now() - start) / duration, 0, 1);
      const eased = cubicInOut(progress);
      const target = followed ? trackedTarget(viewer) : frame.target;
      if (
        !isPickedWorldPosition(target) ||
        !setCameraTargetFrame(viewer, {
          ...frame,
          target,
          heading: frame.heading + headingDelta * eased,
          pitch: (1 - eased) * frame.pitch + eased * destination.pitch,
        })
      ) {
        cancel();
        return;
      }
      if (progress === 1) cancel();
    });
    frames.requestRender('camera-orientation');
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
 * Answer the two map-orientation actions and publish the state their buttons
 * show: whether the map is tilted and the camera's whole-degree heading.
 * The state is published on every rendered frame; its store keeps only a
 * change, so an owner that takes the buttons back shows its state at once.
 */
export function bindCameraOrientationControls({
  viewer,
  publish,
  runNavigation,
  showToast,
}) {
  const removers = [];
  let destroyed = false;
  // The tilt state is the one thing here that costs a depth read of the middle
  // of the screen: 4 ms median and up to 12 ms, measured on this machine. It is
  // therefore held between refreshes rather than recomputed per frame.
  let tilted = false;
  const animator = createCameraOrientationAnimator(viewer);

  /** Recompute the tilt state exactly, paying for one pick. */
  const refreshTilt = () => {
    if (destroyed) return;
    tilted = frameIsTilted(readCameraTargetFrame(viewer));
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
      heading: Math.round(headingDegrees(viewer)) % 360,
    };
    publish?.(next);
  }

  function tilt() {
    if (destroyed) return;
    const pending = animator.destination;
    const result = runNavigation('camera', () => {
      const frame = readCameraTargetFrame(viewer);
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
      const frame = readCameraTargetFrame(viewer);
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

  const subscribe = (remove) => {
    if (typeof remove === 'function') removers.push(remove);
  };
  // The needle follows every frame the scene draws. The camera's `changed`
  // is NOT enough: it only fires past its threshold, so a rotation of a few
  // degrees leaves the needle pointing at the old bearing.
  subscribe(findFrame(viewer)?.on('preRender', sync));
  // The exact tilt state is refreshed once per gesture, not once per frame —
  // moveEnd fires when the camera stops, which is where the pick is affordable.
  subscribe(findCamera(viewer)?.on('moveEnd', refreshTilt));
  if (viewer) removers.push(onFollowChanged(viewer, animator.cancel));
  for (const type of ['pointerdown', 'wheel']) {
    const canvas = viewer?.scene?.canvas;
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
