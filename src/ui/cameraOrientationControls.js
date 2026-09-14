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
  const targetHeading = Math.atan2(localOffset.x, -localOffset.y);
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

/** Toggle between a straight-down map and a useful oblique map angle. */
export function toggleCameraTilt(viewer) {
  const frame = readCameraTargetFrame(viewer);
  if (!frame) return false;
  const tilted = frame.pitch > OBLIQUE_THRESHOLD;
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
}) {
  const tiltButton = elements?.tiltButton;
  const northButton = elements?.northButton;
  const removers = [];
  let destroyed = false;

  const sync = () => {
    if (destroyed) return;
    const frame = readCameraTargetFrame(viewer);
    const tilted = frame ? frame.pitch > OBLIQUE_THRESHOLD : false;
    const heading = headingDegrees(viewer?.camera);
    tiltButton?.setAttribute('aria-pressed', String(tilted));
    tiltButton?.setAttribute(
      'aria-label',
      tilted ? 'Return map to straight-down view' : 'Tilt map to oblique view',
    );
    northButton?.style?.setProperty('--camera-heading', `${heading}deg`);
    northButton?.setAttribute(
      'aria-label',
      `Reset map to north up. Current heading ${Math.round(heading)} degrees`,
    );
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
  const removeCameraChanged = viewer?.camera?.changed?.addEventListener?.(sync);
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
