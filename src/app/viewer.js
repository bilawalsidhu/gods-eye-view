import * as Cesium from 'cesium';
import { applyModelAtmosphereWorkaround } from './atmosphereCompat.js';
import { StarrySky } from '../sky/starrySky.js';
import {
  FREE_LOOK_MAX_HEIGHT_METERS,
  globeOutOfFrame,
  isFreeGlobeCamera,
} from '../globeInView.js';

const PINCH_ZOOM_MULTIPLIER = 8;
const MAX_PINCH_PIXEL_DELTA = 120;

function boundedPinchDelta(delta) {
  if (!Number.isFinite(delta) || delta === 0) return delta;
  return (
    Math.sign(delta) *
    Math.min(Math.abs(delta) * PINCH_ZOOM_MULTIPLIER, MAX_PINCH_PIXEL_DELTA)
  );
}

/**
 * Add browser trackpad pinch to Cesium's zoom inputs and return its disposer.
 * Browsers expose this gesture as a small pixel-mode Ctrl+wheel event.
 */
export function installTrackpadPinchZoom(
  viewer,
  { createWheelEvent = (type, init) => new WheelEvent(type, init) } = {},
) {
  const controller = viewer?.scene?.screenSpaceCameraController;
  const container = viewer?.container;
  const canvas = viewer?.canvas;
  if (!controller || !container || !canvas)
    throw new TypeError('A complete Cesium viewer is required');

  const originalZoomEventTypes = controller.zoomEventTypes;
  const zoomEventTypes = Array.isArray(originalZoomEventTypes)
    ? originalZoomEventTypes
    : originalZoomEventTypes === undefined
      ? []
      : [originalZoomEventTypes];
  const alreadyHandlesControlWheel = zoomEventTypes.some(
    (binding) =>
      binding?.eventType === Cesium.CameraEventType.WHEEL &&
      binding?.modifier === Cesium.KeyboardEventModifier.CTRL,
  );
  const configuredZoomEventTypes = alreadyHandlesControlWheel
    ? originalZoomEventTypes
    : [
        ...zoomEventTypes,
        {
          eventType: Cesium.CameraEventType.WHEEL,
          modifier: Cesium.KeyboardEventModifier.CTRL,
        },
      ];
  if (!alreadyHandlesControlWheel)
    controller.zoomEventTypes = configuredZoomEventTypes;

  const relayedEvents = new WeakSet();
  const relayPinch = (event) => {
    if (
      !event.ctrlKey ||
      relayedEvents.has(event) ||
      event.deltaMode !== 0 ||
      !Number.isFinite(event.deltaY) ||
      event.deltaY === 0
    )
      return;
    let relayed;
    try {
      relayed = createWheelEvent('wheel', {
        deltaX: event.deltaX,
        deltaY: boundedPinchDelta(event.deltaY),
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        screenX: event.screenX,
        screenY: event.screenY,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        view: globalThis.window,
      });
    } catch {
      // The registered Ctrl+wheel binding can still consume the original.
      return;
    }
    relayedEvents.add(relayed);
    event.preventDefault();
    event.stopPropagation();
    canvas.dispatchEvent(relayed);
  };
  container.addEventListener('wheel', relayPinch, {
    capture: true,
    passive: false,
  });

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    container.removeEventListener('wheel', relayPinch, true);
    if (
      !alreadyHandlesControlWheel &&
      controller.zoomEventTypes === configuredZoomEventTypes
    )
      controller.zoomEventTypes = originalZoomEventTypes;
  };
}

/**
 * Allow Cesium's free look only below `maxHeight` and return its disposer.
 * Orbit, tilt and zoom stay available at every height. A value other code
 * sets later is kept as the one to allow below that height, and restored on
 * dispose. `enableLook` gates the Shift+drag binding only: below its trackball
 * height Cesium also turns the camera in place for a drag that starts on the
 * stars. That height is lowered to `maxHeight` too, so above it such a drag
 * orbits the globe, as it does above Cesium's own 7,500 km.
 */
export function installFreeLookHeightLimit(
  viewer,
  maxHeight = FREE_LOOK_MAX_HEIGHT_METERS,
) {
  const scene = viewer?.scene;
  const controller = scene?.screenSpaceCameraController;
  const camera = viewer?.camera;
  if (!controller || !camera || !scene?.preUpdate)
    throw new TypeError('A complete Cesium viewer is required');

  const originalTrackBallHeight = controller.minimumTrackBallHeight;
  const trackBallHeight = Math.min(originalTrackBallHeight, maxHeight);
  controller.minimumTrackBallHeight = trackBallHeight;
  let wanted = controller.enableLook;
  let written;
  const sync = () => {
    if (written !== undefined && controller.enableLook !== written)
      wanted = controller.enableLook;
    const height = camera.positionCartographic?.height;
    written = wanted && !(Number.isFinite(height) && height > maxHeight);
    controller.enableLook = written;
  };
  sync();
  const removeListener = scene.preUpdate.addEventListener(sync);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    removeListener();
    if (controller.enableLook === written) controller.enableLook = wanted;
    if (controller.minimumTrackBallHeight === trackBallHeight)
      controller.minimumTrackBallHeight = originalTrackBallHeight;
  };
}

// How often a moving camera is sampled to see whether it has come to rest, how
// far a pose may drift between samples and still count as at rest, and how
// long after the camera last moved the check gives up if Cesium never raises
// moveEnd.
const SETTLE_SAMPLE_MS = 250;
const SETTLE_POSITION_TOLERANCE_M = 1e-3;
const SETTLE_DIRECTION_TOLERANCE = 1e-9;
const SETTLE_GIVE_UP_MS = 5 * 60_000;

/**
 * Turn the camera back to the planet when a move ends above `minHeight` with
 * no surface on screen (`globeOutOfFrame`: limb glow and slivers up to about
 * one sample cell thick can count as none), and return the disposer. Views with
 * more surface, such as an oblique orbital shot, are left as they are. This
 * catches a saved or shared view that looked away, or any other move that ends
 * looking away from the planet.
 * Heading and position are kept. Tracked cameras, locked ones (non-identity
 * transform), a camera flight in progress, the 2D and Columbus modes, and any
 * time `paused` returns true (an authored scene playing) are left alone.
 * `keyholeRadius`
 * returns the radius of the visible circle when a scope mask hides the rest of
 * the frame (see `globeFrameShare`), or 0; it is read at every check.
 *
 * Cesium's `moveEnd` alone is not enough: Cesium compares the camera with the
 * last frame's to the last rounding error, and at some of these poses the
 * camera drifts by a rounding error every frame, so Cesium never sees it stop.
 * So each `moveStart` also starts a check of its own that samples the pose
 * every 250 ms, with a tolerance for that drift, and once the pose has held
 * for half a second after moving runs the same recovery. It keeps watching
 * until Cesium raises `moveEnd`, since under that drift Cesium raises no new
 * `moveStart` for a later move, and gives up five minutes after the camera
 * last moved.
 * `setTimeout` and `clearTimeout` can be injected for tests.
 */
export function installGlobeInViewRecovery(
  viewer,
  {
    minHeight = FREE_LOOK_MAX_HEIGHT_METERS,
    keyholeRadius = () => 0,
    paused = () => false,
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: unschedule = globalThis.clearTimeout,
  } = {},
) {
  const scene = viewer?.scene;
  const camera = viewer?.camera;
  if (!scene || !camera?.moveEnd || !camera?.moveStart)
    throw new TypeError('A complete Cesium viewer is required');

  const recover = () => {
    if (!isFreeGlobeCamera(viewer)) return;
    // Cesium has no public running-flight flag.
    if (camera._currentFlight || paused()) return;
    const height = camera.positionCartographic?.height;
    if (
      !(height > minHeight) ||
      !globeOutOfFrame(camera, { keyholeRadius: keyholeRadius() })
    )
      return;
    camera.setView({
      orientation: {
        heading: camera.heading,
        pitch: -Cesium.Math.PI_OVER_TWO,
        roll: 0,
      },
    });
    scene.requestRender?.();
  };

  const lastPosition = new Cesium.Cartesian3();
  const lastDirection = new Cesium.Cartesian3();
  let settleTimer = null;
  let settleElapsed = 0;
  let restingSamples = 0;
  let movedSinceCheck = false;
  const stopSettling = () => {
    if (settleTimer !== null) unschedule(settleTimer);
    settleTimer = null;
  };
  const sample = () => {
    settleTimer = null;
    settleElapsed += SETTLE_SAMPLE_MS;
    const atRest =
      Cesium.Cartesian3.equalsEpsilon(
        camera.positionWC,
        lastPosition,
        0,
        SETTLE_POSITION_TOLERANCE_M,
      ) &&
      Cesium.Cartesian3.equalsEpsilon(
        camera.directionWC,
        lastDirection,
        0,
        SETTLE_DIRECTION_TOLERANCE,
      );
    restingSamples = atRest ? restingSamples + 1 : 0;
    if (!atRest) {
      movedSinceCheck = true;
      settleElapsed = 0;
    }
    // Two quiet samples in a row after a move: at rest for half a second, as
    // for moveEnd.
    if (restingSamples >= 2 && movedSinceCheck) {
      movedSinceCheck = false;
      recover();
    }
    if (settleElapsed >= SETTLE_GIVE_UP_MS) return;
    Cesium.Cartesian3.clone(camera.positionWC, lastPosition);
    Cesium.Cartesian3.clone(camera.directionWC, lastDirection);
    settleTimer = schedule(sample, SETTLE_SAMPLE_MS);
  };
  const startSettling = () => {
    stopSettling();
    settleElapsed = 0;
    restingSamples = 0;
    movedSinceCheck = true;
    Cesium.Cartesian3.clone(camera.positionWC, lastPosition);
    Cesium.Cartesian3.clone(camera.directionWC, lastDirection);
    settleTimer = schedule(sample, SETTLE_SAMPLE_MS);
  };
  const removeMoveEnd = camera.moveEnd.addEventListener(() => {
    stopSettling();
    recover();
  });
  const removeMoveStart = camera.moveStart.addEventListener(startSettling);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    stopSettling();
    removeMoveEnd();
    removeMoveStart();
  };
}

/** Cesium.Viewer options of the standard globe viewer. */
export function applicationViewerOptions(creditContainer) {
  return {
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    vrButton: false,
    selectionIndicator: false,
    infoBox: false,
    baseLayer: false,
    // Replaces the blocky Tycho-2 default. An option, not `skyBox: false`,
    // which would also stop CesiumWidget from creating the Sun and Moon.
    skyBox: new StarrySky(),
    creditContainer,
    msaaSamples: 4,
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
  };
}

/** Create the standard globe viewer in caller-owned, visible containers. */
export function createApplicationViewer({ container, creditContainer }) {
  if (!container || !creditContainer)
    throw new TypeError('Viewer and credit containers are required');
  const viewer = new Cesium.Viewer(
    container,
    applicationViewerOptions(creditContainer),
  );
  try {
    viewer.targetFrameRate = 60;
    // A phone pinch spans fewer screen pixels than desktop zoom gestures.
    // Keep Cesium's distance-aware zoom and collision limits, with less travel
    // required on touch-first screens. Mouse/trackpad sensitivity stays native.
    if (globalThis.matchMedia?.('(pointer: coarse)').matches)
      viewer.scene.screenSpaceCameraController.zoomFactor *= 3;
    // Before any tile builds a draw command: Cesium's per-vertex model
    // atmosphere fails to LINK on Apple's Metal backend and kills the
    // render loop. See app/atmosphereCompat.js.
    applyModelAtmosphereWorkaround(viewer.scene);
    viewer.scene.globe.show = false;
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.skyAtmosphere.atmosphereLightIntensity = 18;
    viewer.scene.skyAtmosphere.saturationShift = -0.12;
    viewer.scene.skyAtmosphere.brightnessShift = -0.08;
    return viewer;
  } catch (error) {
    viewer.destroy();
    throw error;
  }
}
