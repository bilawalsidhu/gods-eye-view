import * as Cesium from 'cesium';
import { isPickedWorldPosition } from '../data/scenePick.js';

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
  const target = pickViewTarget(viewer);
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
    camera.lookAt(
      frame.target,
      new Cesium.HeadingPitchRange(
        normalizedHeading(frame.heading),
        frame.pitch,
        frame.range,
      ),
    );
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
 * Whether the map currently reads as tilted, from the camera alone.
 *
 * `readCameraTargetFrame` answers the same question more precisely, but it
 * costs a depth-buffer read of the viewport center — measured at 4 ms median
 * and up to 12 ms on this machine — and the camera-changed event fires once
 * per frame while the map is being dragged. The camera's own pitch matches the
 * picked frame's to within 0.02 degrees at every altitude where a tilt control
 * is useful (measured to 20 km); it diverges only at globe distances, where
 * the viewport center is most of a hemisphere away. The button state and the
 * toggle read the same predicate, so what the button shows is always what the
 * next click will do.
 */
export function isTiltedView(camera) {
  const pitch = Number(camera?.pitch);
  return Number.isFinite(pitch) ? pitch > OBLIQUE_THRESHOLD : false;
}

/** Toggle between a straight-down map and a useful oblique map angle. */
export function toggleCameraTilt(viewer) {
  const frame = readCameraTargetFrame(viewer);
  if (!frame) return false;
  const tilted = isTiltedView(viewer?.camera);
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

/** Bind the two map-orientation actions and keep their accessible state current. */
export function bindCameraOrientationControls({
  viewer,
  elements,
  runNavigation,
  showToast,
  requestFrame = (callback) =>
    globalThis.requestAnimationFrame
      ? globalThis.requestAnimationFrame(callback)
      : setTimeout(callback, 16),
}) {
  const tiltButton = elements?.tiltButton;
  const northButton = elements?.northButton;
  const removers = [];
  let destroyed = false;
  let scheduled = false;
  let applied = null;

  /** Write the two controls' state, but only what actually changed. */
  const sync = () => {
    if (destroyed) return;
    const camera = viewer?.camera;
    const next = {
      tilted: isTiltedView(camera),
      heading: Math.round(headingDegrees(camera)) % 360,
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
      northButton?.style?.setProperty('--camera-heading', `${next.heading}deg`);
      northButton?.setAttribute(
        'aria-label',
        `Reset map to north up. Current heading ${next.heading} degrees`,
      );
    }
    applied = next;
  };

  // camera.changed fires once per rendered frame while the map is dragged, so
  // coalesce a burst into one write per frame.
  const scheduleSync = () => {
    if (destroyed || scheduled) return;
    scheduled = true;
    requestFrame(() => {
      scheduled = false;
      sync();
    });
  };

  const listen = (element, handler) => {
    if (!element) return;
    element.addEventListener('click', handler);
    removers.push(() => element.removeEventListener('click', handler));
  };
  listen(tiltButton, () => {
    const result = runNavigation('camera', () => toggleCameraTilt(viewer));
    if (result)
      showToast?.(result.tilted ? 'Tilted view' : 'Straight-down view');
    sync();
  });
  listen(northButton, () => {
    const result = runNavigation('camera', () => resetCameraNorth(viewer));
    if (result) showToast?.('North up');
    sync();
  });
  const removeCameraChanged =
    viewer?.camera?.changed?.addEventListener?.(scheduleSync);
  if (typeof removeCameraChanged === 'function')
    removers.push(removeCameraChanged);
  sync();

  return {
    sync,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const remove of removers.splice(0)) remove();
    },
  };
}
