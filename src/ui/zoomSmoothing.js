import * as Cesium from 'cesium';

/**
 * @module zoomSmoothing
 * @description Trackpad zoom smoothing. Prefers Cesium built-in camera
 * controller options before custom handling. Adds rAF-based easing and
 * distinct sensitivity for trackpad vs mouse wheel and pinch.
 */

/**
 * Configure built-in ScreenSpaceCameraController zoom options.
 * @param {Cesium.Viewer} viewer
 * @returns {object|null} Original controller snapshot to restore on destroy
 */
export function configureZoomController(viewer) {
  const controller = viewer?.scene?.screenSpaceCameraController;
  if (!controller) return null;
  const original = {
    enableZoom: controller.enableZoom,
    inertiaZoom: controller.inertiaZoom,
    inertiaSpin: controller.inertiaSpin,
    zoomFactor: controller.zoomFactor,
    minimumZoomRate: controller.minimumZoomRate,
    maximumZoomRate: controller.maximumZoomRate,
  };
  // Prefer engine support: enable inertia for smoothness, moderate zoom factor
  controller.enableZoom = true;
  controller.inertiaZoom = 0.85;
  controller.inertiaSpin = 0.9;
  if (Number.isFinite(controller.zoomFactor)) controller.zoomFactor = 1.08;
  if (Number.isFinite(controller.minimumZoomRate))
    controller.minimumZoomRate = 0.2;
  if (Number.isFinite(controller.maximumZoomRate))
    controller.maximumZoomRate = 2.5;
  return original;
}

/**
 * Install custom trackpad-aware wheel handling with rAF easing.
 * Detects trackpad vs mouse via delta size/frequency and ctrlKey pinch.
 * @param {Cesium.Viewer} viewer
 * @param {object} original Original controller snapshot from configureZoomController
 * @returns {{destroy: Function}}
 */
export function installZoomSmoothing(viewer, original) {
  const canvas = viewer?.scene?.canvas;
  const controller = viewer?.scene?.screenSpaceCameraController;
  if (!canvas || !controller) {
    return { destroy() {} };
  }

  let targetHeightOffset = 0;
  let animationFrame = null;
  let lastWheelTime = 0;
  let smallDeltaCount = 0;

  const easingRate = 0.18;

  const stepToward = () => {
    if (Math.abs(targetHeightOffset) < 1) {
      targetHeightOffset = 0;
      animationFrame = null;
      return;
    }
    const camera = viewer.camera;
    const amount = targetHeightOffset * easingRate;
    targetHeightOffset -= amount;
    // Move camera along its view direction (zoom)
    const direction = Cesium.Cartesian3.normalize(
      camera.direction,
      new Cesium.Cartesian3(),
    );
    const move = Cesium.Cartesian3.multiplyByScalar(
      direction,
      amount,
      new Cesium.Cartesian3(),
    );
    try {
      camera.position = Cesium.Cartesian3.add(
        camera.position,
        move,
        new Cesium.Cartesian3(),
      );
    } catch {
      /* teardown race */
    }
    viewer.scene.requestRender?.();
    animationFrame = requestAnimationFrame(stepToward);
  };

  const onWheel = (event) => {
    const now = performance.now();
    const delta = event.deltaY;
    const isPinch = event.ctrlKey === true;
    const isSmallDelta = Math.abs(delta) < 40 && event.deltaMode === 0;

    // Heuristic: consecutive small deltas = trackpad
    if (isSmallDelta) {
      smallDeltaCount = Math.min(smallDeltaCount + 1, 10);
    } else if (Math.abs(delta) >= 80) {
      smallDeltaCount = Math.max(smallDeltaCount - 1, 0);
    }

    const isTrackpad =
      isPinch ||
      smallDeltaCount >= 3 ||
      (isSmallDelta && now - lastWheelTime < 80);
    lastWheelTime = now;

    let sensitivity;
    if (isPinch) {
      // Pinch needs lower sensitivity: synthetic wheel with ctrlKey
      sensitivity = 8;
    } else if (isTrackpad) {
      // Continuous small deltas: gentler
      sensitivity = 6;
    } else {
      // Discrete mouse wheel: leave native behavior (do not intercept)
      return;
    }

    // For trackpad/pinch we smooth via rAF rather than snapping
    event.preventDefault();
    const height = viewer.camera.positionCartographic?.height || 10000;
    const scale = Math.max(
      0.02,
      Math.min(0.2, ((delta * sensitivity) / Math.max(5000, height)) * height),
    );
    // Camera forward direction amount is proportional to current height
    const factor = isPinch ? 0.008 : 0.015;
    targetHeightOffset += delta * height * factor * 0.001 * 1000;
    // Clamp to avoid runaway
    targetHeightOffset = Math.max(
      -height * 0.5,
      Math.min(height * 0.5, targetHeightOffset),
    );

    if (animationFrame == null) {
      animationFrame = requestAnimationFrame(stepToward);
    }
  };

  canvas.addEventListener('wheel', onWheel, { passive: false });

  return {
    destroy() {
      canvas.removeEventListener('wheel', onWheel);
      if (animationFrame != null) cancelAnimationFrame(animationFrame);
      animationFrame = null;
      targetHeightOffset = 0;
      if (original && controller) {
        Object.assign(controller, original);
      }
    },
  };
}

/**
 * One-shot setup: configure built-in options, then optionally add custom smoothing.
 * @param {Cesium.Viewer} viewer
 * @returns {{destroy: Function}}
 */
export function setupZoomSmoothing(viewer) {
  const original = configureZoomController(viewer);
  const smoothing = installZoomSmoothing(viewer, original);
  return {
    destroy() {
      smoothing.destroy();
    },
  };
}
