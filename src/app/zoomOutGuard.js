import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';

/** Whole-Earth view. Programmatic flights ignore it; only user input stops here. */
export const MAXIMUM_ZOOM_DISTANCE_M = 40_000_000;
/** Below this, oblique browsing is left alone. */
export const PITCH_CLAMP_MIN_HEIGHT_M = 300_000;
/** Look this far below the Earth's limb, so the globe stays on screen. */
export const LIMB_MARGIN_RAD = Cesium.Math.toRadians(8);
/** How long after the last zoom input the camera still counts as user-zoomed. */
export const USER_ZOOM_WINDOW_MS = 500;
/** Fraction of the remaining pitch error closed per frame. */
const PITCH_EASE = 0.35;
const PITCH_SNAP_RAD = Cesium.Math.toRadians(0.1);
const EARTH_RADIUS_M = 6_371_000;

/**
 * The shallowest pitch (radians, negative is down) that still keeps the Earth
 * framed from height `h`, or null where tilted views are left alone.
 * The limb sits acos(R / (R + h)) below the local horizontal.
 */
export function maxPitchForHeight(h) {
  if (!(h >= PITCH_CLAMP_MIN_HEIGHT_M)) return null;
  const limb = Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + h));
  return -Math.min(limb + LIMB_MARGIN_RAD, Cesium.Math.PI_OVER_TWO);
}

function isUserZoomInput(event) {
  if (event.type === 'wheel') return true;
  if (event.type === 'touchmove') return (event.touches?.length ?? 0) >= 2;
  // Cesium's default zoom bindings also include a right-button drag.
  return event.type === 'pointermove' && (event.buttons & 2) === 2;
}

/**
 * Stop a tilted wheel/pinch zoom-out from flying the camera off into space.
 *
 * Cesium zooms a shallow view out by backing along the cursor ray with the
 * pitch held fixed, and with no ceiling. The limb drops below a fixed pitch
 * by ~700 km, then the steps grow with height and never stop. This caps the
 * zoom distance and, only while the user is zooming out, pitches the view
 * down to keep the globe framed. Returns its disposer.
 */
export function installZoomOutGuard(
  viewer,
  { now = () => performance.now(), requestRender = governorRequestRender } = {},
) {
  const scene = viewer?.scene;
  const controller = scene?.screenSpaceCameraController;
  const camera = viewer?.camera;
  const container = viewer?.container;
  if (!controller || !camera || !container || !scene.preRender)
    throw new TypeError('A complete Cesium viewer is required');

  const originalMaximumZoomDistance = controller.maximumZoomDistance;
  controller.maximumZoomDistance = MAXIMUM_ZOOM_DISTANCE_M;

  let lastUserZoomAt = -Infinity;
  const markInput = (event) => {
    if (isUserZoomInput(event)) lastUserZoomAt = now();
  };
  const inputTypes = ['wheel', 'touchmove', 'pointermove'];
  for (const type of inputTypes)
    container.addEventListener(type, markInput, {
      capture: true,
      passive: true,
    });

  let lastHeight = NaN;
  const guard = () => {
    const height = camera.positionCartographic?.height;
    const previousHeight = lastHeight;
    lastHeight = height;
    if (!(height > previousHeight)) return; // Zoom-out only.
    if (now() - lastUserZoomAt > USER_ZOOM_WINDOW_MS) return;
    if (controller.enableInputs === false) return;
    if (!Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY))
      return;
    // Cesium keeps no public flag for a running flyTo; never fight one.
    if (camera._currentFlight) return;
    const maxPitch = maxPitchForHeight(height);
    if (maxPitch === null || !(camera.pitch > maxPitch)) return;
    const error = maxPitch - camera.pitch;
    const pitch =
      Math.abs(error) <= PITCH_SNAP_RAD
        ? maxPitch
        : camera.pitch + error * PITCH_EASE;
    camera.setView({
      orientation: { heading: camera.heading, pitch, roll: camera.roll },
    });
    lastHeight = camera.positionCartographic?.height;
    requestRender('zoom-out-guard');
  };
  const removePreRender = scene.preRender.addEventListener(guard);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    removePreRender?.();
    for (const type of inputTypes)
      container.removeEventListener(type, markInput, true);
    if (controller.maximumZoomDistance === MAXIMUM_ZOOM_DISTANCE_M)
      controller.maximumZoomDistance = originalMaximumZoomDistance;
  };
}
