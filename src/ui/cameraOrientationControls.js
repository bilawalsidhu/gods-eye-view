import * as Cesium from 'cesium';
import { isPickedWorldPosition } from '../data/scenePick.js';

function trackedTarget(viewer) {
  const entity = viewer.trackedEntity;
  // Read the visual's sample first; sampling a flight CallbackProperty twice
  // can advance dead reckoning ahead of the displayed aircraft.
  return (
    entity?.gevDisplayPosition?.() ||
    entity?.position?.getValue(viewer.clock?.currentTime)
  );
}

export const OBLIQUE_PITCH = Cesium.Math.toRadians(-35);
export const STRAIGHT_DOWN_PITCH = Cesium.Math.toRadians(-89);
const OBLIQUE_THRESHOLD = Cesium.Math.toRadians(-60);

function normalizedHeading(heading) {
  const wrapped = Cesium.Math.zeroToTwoPi(
    Number.isFinite(heading) ? heading : 0,
  );
  return Math.abs(wrapped - Cesium.Math.TWO_PI) < Cesium.Math.EPSILON10
    ? 0
    : wrapped;
}

/** Return the world position under the center of the canvas, when available. */
export function pickViewTarget(viewer) {
  const scene = viewer?.scene;
  const camera = viewer?.camera;
  const canvas = scene?.canvas;
  if (!scene || !camera || !canvas) return null;
  const width = canvas.clientWidth || canvas.width || 0;
  const height = canvas.clientHeight || canvas.height || 0;
  if (!width || !height) return null;
  const center = new Cesium.Cartesian2(width / 2, height / 2);
  let target = null;

  if (scene.pickPositionSupported && typeof scene.pickPosition === 'function') {
    try {
      target = scene.pickPosition(center);
    } catch {
      target = null;
    }
  }
  // Terrain before the ellipsoid: globe.pick intersects the rendered surface,
  // so over keyless elevated terrain it returns the ground the operator is
  // looking at. pickEllipsoid answers with sea level, which on a plateau sits
  // far below the view and would swing the camera on every tilt.
  if (
    !isPickedWorldPosition(target) &&
    typeof camera.getPickRay === 'function'
  ) {
    try {
      target = scene.globe?.pick(camera.getPickRay(center), scene) || null;
    } catch {
      target = null;
    }
  }
  if (
    !isPickedWorldPosition(target) &&
    typeof camera.pickEllipsoid === 'function'
  ) {
    try {
      target = camera.pickEllipsoid(center, Cesium.Ellipsoid.WGS84);
    } catch {
      target = null;
    }
  }
  return isPickedWorldPosition(target) ? target : null;
}

/** Describe the camera as an orbit around the current viewport center. */
export function readCameraTargetFrame(viewer) {
  const camera = viewer?.camera;
  const target = viewer?.trackedEntity
    ? trackedTarget(viewer)
    : pickViewTarget(viewer);
  if (!camera || !target || !isPickedWorldPosition(camera.positionWC))
    return null;

  const transform = Cesium.Transforms.eastNorthUpToFixedFrame(target);
  const inverse = Cesium.Matrix4.inverseTransformation(
    transform,
    new Cesium.Matrix4(),
  );
  const localOffset = Cesium.Matrix4.multiplyByPoint(
    inverse,
    camera.positionWC,
    new Cesium.Cartesian3(),
  );
  const range = Cesium.Cartesian3.magnitude(localOffset);
  if (!Number.isFinite(range) || range < 1) return null;

  const pitch = -Math.asin(Cesium.Math.clamp(localOffset.z / range, -1, 1));
  // Cesium places a lookAt camera at range * (-sin h cos p, -cos h cos p,
  // -sin p) in the target's east-north-up frame, so recovering h means
  // negating BOTH horizontal components. Negating only the north one reads
  // every heading as its mirror image (30 deg comes back as 330), which would
  // make north-up rotate the wrong way from three quarters of the compass.
  const targetHeading = Math.atan2(-localOffset.x, -localOffset.y);
  const heading = normalizedHeading(
    pitch < Cesium.Math.toRadians(-88.5) ? camera.heading : targetHeading,
  );
  return { target, range, heading, pitch };
}

/** Apply an orbit frame, then return the camera to Cesium's fixed-world frame. */
export function setCameraTargetFrame(viewer, frame) {
  const camera = viewer?.camera;
  if (!camera || !frame?.target || !Number.isFinite(frame.range)) return false;
  try {
    const trackedTransform = viewer.trackedEntity
      ? Cesium.Matrix4.clone(camera.transform)
      : null;
    camera.lookAt(
      frame.target,
      new Cesium.HeadingPitchRange(
        normalizedHeading(frame.heading),
        frame.pitch,
        frame.range,
      ),
    );
    if (trackedTransform) {
      // Preserve EntityView's reference frame (including satellite frames).
      // Its next update carries this new local offset along with the target.
      camera.lookAtTransform(trackedTransform);
      viewer.scene?.requestRender?.();
      return true;
    }
    const destination = Cesium.Cartesian3.clone(camera.positionWC);
    const direction = Cesium.Cartesian3.clone(camera.directionWC);
    const up = Cesium.Cartesian3.clone(camera.upWC);
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    if (destination && direction && up) {
      camera.setView({ destination, orientation: { direction, up } });
    }
    viewer.scene?.requestRender?.();
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
export function frameIsTilted(frame) {
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

function headingDegrees(camera) {
  return Cesium.Math.toDegrees(normalizedHeading(camera?.heading));
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
    if (!viewer.scene?.preUpdate?.addEventListener || duration <= 0)
      return setCameraTargetFrame(viewer, { ...frame, ...destination });
    const entity = viewer.trackedEntity;
    pending = destination;
    const start = now();
    const headingDelta = Cesium.Math.negativePiToPi(
      destination.heading - frame.heading,
    );
    remove = viewer.scene.preUpdate.addEventListener(() => {
      if (viewer.isDestroyed?.() || viewer.trackedEntity !== entity) {
        cancel();
        return;
      }
      const progress = Cesium.Math.clamp((now() - start) / duration, 0, 1);
      const eased = Cesium.EasingFunction.CUBIC_IN_OUT(progress);
      const target = entity ? trackedTarget(viewer) : frame.target;
      if (
        !isPickedWorldPosition(target) ||
        !setCameraTargetFrame(viewer, {
          ...frame,
          target,
          heading: frame.heading + headingDelta * eased,
          pitch: Cesium.Math.lerp(frame.pitch, destination.pitch, eased),
        })
      ) {
        cancel();
        return;
      }
      if (progress === 1) cancel();
    });
    viewer.scene.requestRender?.();
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

/** Bind the two map-orientation actions and keep their accessible state current. */
export function bindCameraOrientationControls({
  viewer,
  elements,
  runNavigation,
  showToast,
}) {
  const tiltButton = elements?.tiltButton;
  const northButton = elements?.northButton;
  const removers = [];
  let destroyed = false;
  let applied = null;
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
   * Write the two controls' state, but only what actually changed.
   *
   * The compass needle reads the camera's own bearing, which costs nothing, so
   * this can run on every rendered frame: measured at 1.4 ms across 120 frames
   * of a continuously dragged map (0.012 ms per frame, 0.1 ms worst case),
   * against the 4 ms per frame the depth read it replaced would have cost.
   */
  function sync() {
    if (destroyed) return;
    const next = {
      tilted,
      heading: Math.round(headingDegrees(viewer?.camera)) % 360,
    };
    if (
      applied &&
      applied.tilted === next.tilted &&
      applied.heading === next.heading
    )
      return;
    if (!applied || applied.tilted !== next.tilted) {
      tiltButton?.setAttribute('aria-pressed', String(next.tilted));
      tiltButton?.setAttribute(
        'aria-label',
        next.tilted
          ? 'Return map to straight-down view'
          : 'Tilt map to oblique view',
      );
    }
    if (!applied || applied.heading !== next.heading) {
      northButton?.setAttribute('data-north-up', String(next.heading === 0));
      northButton?.style?.setProperty('--camera-heading', `${next.heading}deg`);
      northButton?.setAttribute(
        'aria-label',
        `Reset map to north up. Current heading ${next.heading} degrees`,
      );
    }
    applied = next;
  }

  const listen = (element, handler) => {
    if (!element) return;
    element.addEventListener('click', handler);
    removers.push(() => element.removeEventListener('click', handler));
  };
  listen(tiltButton, () => {
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
      showToast?.(result.tilted ? 'Tilted view' : 'Straight-down view');
      // The action reports the state it just commanded, so the button can
      // follow it without a second pick.
      tilted = result.tilted;
    }
    sync();
  });
  listen(northButton, () => {
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
    if (result) showToast?.('North up');
    sync();
  });

  const subscribe = (event, handler) => {
    const remove = event?.addEventListener?.(handler);
    if (typeof remove === 'function') removers.push(remove);
  };
  // The needle follows every frame the scene draws. `camera.changed` is NOT
  // enough: it only fires past `camera.percentageChanged`, so a rotation of a
  // few degrees leaves the needle pointing at the old bearing.
  subscribe(viewer?.scene?.preRender, sync);
  // The exact tilt state is refreshed once per gesture, not once per frame —
  // moveEnd fires when the camera stops, which is where the pick is affordable.
  subscribe(viewer?.camera?.moveEnd, refreshTilt);
  subscribe(viewer?.trackedEntityChanged, animator.cancel);
  for (const type of ['pointerdown', 'wheel']) {
    const canvas = viewer?.scene?.canvas;
    canvas?.addEventListener?.(type, animator.cancel, { passive: true });
    removers.push(() => canvas?.removeEventListener?.(type, animator.cancel));
  }
  refreshTilt();

  return {
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
