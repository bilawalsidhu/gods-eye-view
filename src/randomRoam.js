import * as Cesium from 'cesium';

const DEFAULT_MIN_LAT = -70;
const DEFAULT_MAX_LAT = 70;
const DEFAULT_MIN_HEIGHT = 250_000;
const DEFAULT_MAX_HEIGHT = 2_500_000;
const DEFAULT_MIN_DURATION = 8;
const DEFAULT_MAX_DURATION = 18;
const DEFAULT_MIN_PAUSE_MS = 3_000;
const DEFAULT_MAX_PAUSE_MS = 9_000;
const DEFAULT_MIN_PITCH_DEG = -80;
const DEFAULT_MAX_PITCH_DEG = -35;

function interpolate(random, min, max) {
  return min + random() * (max - min);
}

/**
 * Create a small controller that flies the camera through random world views.
 * The controller owns only the camera flight loop and button state; callers own
 * where the button lives and when the controller is destroyed.
 */
export function createRandomRoamController({
  viewer,
  button = null,
  random = Math.random,
  timers = globalThis,
  cartesianFromDegrees = Cesium.Cartesian3.fromDegrees,
  toRadians = Cesium.Math.toRadians,
  minLatitude = DEFAULT_MIN_LAT,
  maxLatitude = DEFAULT_MAX_LAT,
  minHeight = DEFAULT_MIN_HEIGHT,
  maxHeight = DEFAULT_MAX_HEIGHT,
  minDuration = DEFAULT_MIN_DURATION,
  maxDuration = DEFAULT_MAX_DURATION,
  minPauseMs = DEFAULT_MIN_PAUSE_MS,
  maxPauseMs = DEFAULT_MAX_PAUSE_MS,
  minPitchDeg = DEFAULT_MIN_PITCH_DEG,
  maxPitchDeg = DEFAULT_MAX_PITCH_DEG,
} = {}) {
  let active = false;
  let timer = null;

  const setButtonState = () => {
    button?.classList?.toggle?.('active', active);
    button?.setAttribute?.('aria-pressed', String(active));
  };

  const clearQueuedHop = () => {
    if (!timer) return;
    timers.clearTimeout?.(timer);
    timer = null;
  };

  const hop = () => {
    timer = null;
    if (!active || !viewer?.camera?.flyTo) return false;

    const lon = interpolate(random, -180, 180);
    const lat = interpolate(random, minLatitude, maxLatitude);
    const height = interpolate(random, minHeight, maxHeight);
    const heading = interpolate(random, 0, Math.PI * 2);
    const pitch = toRadians(interpolate(random, minPitchDeg, maxPitchDeg));
    const duration = interpolate(random, minDuration, maxDuration);

    viewer.camera.flyTo({
      destination: cartesianFromDegrees(lon, lat, height),
      orientation: { heading, pitch, roll: 0 },
      duration,
      complete: () => {
        if (!active) return;
        const pause = interpolate(random, minPauseMs, maxPauseMs);
        timer = timers.setTimeout?.(hop, pause) || null;
      },
    });
    return true;
  };

  const controller = {
    get active() {
      return active;
    },
    start() {
      if (active) return false;
      if (!viewer?.camera?.flyTo) return false;
      active = true;
      setButtonState();
      return hop();
    },
    stop() {
      if (!active && !timer) return false;
      active = false;
      clearQueuedHop();
      viewer?.camera?.cancelFlight?.();
      setButtonState();
      return true;
    },
    toggle() {
      return active ? controller.stop() : controller.start();
    },
    destroy() {
      controller.stop();
    },
  };

  setButtonState();
  return controller;
}
