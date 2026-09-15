import * as Cesium from 'cesium';

/** Create the standard globe viewer in caller-owned, visible containers. */
export function createApplicationViewer({ container, creditContainer }) {
  if (!container || !creditContainer)
    throw new TypeError('Viewer and credit containers are required');
  const viewer = new Cesium.Viewer(container, {
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
    creditContainer,
    msaaSamples: 4,
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
  });
  try {
    viewer.targetFrameRate = 60;
    viewer.scene.globe.show = false;
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.skyAtmosphere.atmosphereLightIntensity = 18;
    viewer.scene.skyAtmosphere.saturationShift = -0.12;
    viewer.scene.skyAtmosphere.brightnessShift = -0.08;
    // Prefer Cesium's built-in camera controller smoothing before custom handling
    const controller = viewer.scene.screenSpaceCameraController;
    if (controller) {
      controller.inertiaSpin = 0.9;
      controller.inertiaTranslate = 0.9;
      controller.inertiaZoom = 0.85;
      if (Number.isFinite(controller.zoomFactor)) controller.zoomFactor = 1.08;
    }
    return viewer;
  } catch (error) {
    viewer.destroy();
    throw error;
  }
}
