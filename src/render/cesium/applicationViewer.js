import * as Cesium from 'cesium';
import { applyModelAtmosphereWorkaround } from '../../app/atmosphereCompat.js';
import { IDLE_FRAME_RATE } from '../../renderGovernor.js';
import { preloadImageryAhead } from './imageryLookAhead.js';
import { StarrySky } from './starrySky.js';

/**
 * At the farthest a hand can zoom out, the globe is this share of the
 * screen's height across. Cesium sets no limit, so zooming on left the globe
 * a speck among the stars.
 */
const MIN_GLOBE_SHARE = 0.3;

/**
 * The farthest a hand can zoom out, in metres above the ellipsoid, for a
 * vertical field of view. It follows the screen's shape, as the app's own
 * whole-globe view does, so that view always lies within it.
 * @param {number} fovy Vertical field of view, radians.
 */
export function zoomOutLimit(fovy) {
  const radius = Cesium.Ellipsoid.WGS84.maximumRadius;
  const angular = Math.atan(MIN_GLOBE_SHARE * Math.tan(fovy / 2));
  return radius / Math.sin(angular) - radius;
}

/**
 * Hold a hand's zoom out to `zoomOutLimit` on the globe, each frame, since the
 * field of view follows the screen's shape. The limit never sits below the
 * camera: one already past it (a flight, a screen turned) stops there rather
 * than jumping in at the next zoom. Flat maps keep Cesium's own, unlimited.
 * @returns {() => void} Stop limiting.
 */
export function limitZoomOut(viewer) {
  const { scene, camera } = viewer;
  return scene.preRender.addEventListener(() => {
    const controller = scene.screenSpaceCameraController;
    const fovy = camera.frustum.fovy;
    if (scene.mode !== Cesium.SceneMode.SCENE3D || !Number.isFinite(fovy)) {
      controller.maximumZoomDistance = Number.POSITIVE_INFINITY;
      return;
    }
    controller.maximumZoomDistance = Math.max(
      zoomOutLimit(fovy),
      camera.positionCartographic?.height ?? 0,
    );
  });
}

// Dev convenience: expose the app's Cesium instance for console/preview probing
// (single shared module instance — avoids dual-Cesium state bugs when testing).
if (typeof window !== 'undefined' && !window.__CESIUM__)
  window.__CESIUM__ = Cesium;

/**
 * Cesium.Viewer options of the standard globe viewer. `showRenderLoopErrors`
 * false leaves render errors to the caller's own notice instead of Cesium's
 * panel; `msaa` is the multisampling to start with (0 off, 4 by default).
 * The drawing buffer is kept after presenting, for `capture` and
 * `readPixels` to read the frame drawn.
 */
export function applicationViewerOptions(
  creditContainer,
  { showRenderLoopErrors = true, msaa = 4 } = {},
) {
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
    // Cesium's 1 is no multisampling.
    msaaSamples: msaa || 1,
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
    showRenderLoopErrors,
  };
}

/**
 * Create the standard globe viewer in caller-owned, visible containers;
 * `msaa` as `applicationViewerOptions` takes it.
 */
export function createApplicationViewer({
  container,
  creditContainer,
  showRenderLoopErrors,
  msaa,
}) {
  if (!container || !creditContainer)
    throw new TypeError('Viewer and credit containers are required');
  const viewer = new Cesium.Viewer(
    container,
    applicationViewerOptions(creditContainer, {
      showRenderLoopErrors,
      msaa,
    }),
  );
  try {
    // Until the frame port takes over (appRenderer.js), tick at the idle
    // rate so the startup load does not compete with drawing at 240 fps.
    viewer.targetFrameRate = IDLE_FRAME_RATE;
    // No double-click follow or zoom: the Viewer's own (it tracked or
    // zoomed to the entity picked) is off. Following is a layer's click.
    viewer.screenSpaceEventHandler.removeInputAction(
      Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    );
    // A phone pinch spans fewer screen pixels than desktop zoom gestures.
    // Keep Cesium's distance-aware zoom and collision limits, with less travel
    // required on touch-first screens. Mouse/trackpad sensitivity stays native.
    if (globalThis.matchMedia?.('(pointer: coarse)').matches)
      viewer.scene.screenSpaceCameraController.zoomFactor *= 3;
    limitZoomOut(viewer);
    // A narrow view carried along an orbit outruns the imagery under it.
    preloadImageryAhead(viewer);
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
