import * as geo from './geo/index.js';
import { engineFromViewer } from './globe/cesium/engineFromViewer.js';

/**
 * Camera presets for notable locations.
 * Phase 1 default: fly to Austin, TX on load.
 */
export const CAMERA_PRESETS = {
  austin: {
    destination: geo.cartesian3.fromDegrees(-97.7431, 30.2672, 800),
    orientation: {
      heading: geo.math.toRadians(0),
      pitch: geo.math.toRadians(-35),
      roll: 0.0,
    },
  },
  sf: {
    destination: geo.cartesian3.fromDegrees(-122.4194, 37.7749, 1000),
    orientation: {
      heading: geo.math.toRadians(30),
      pitch: geo.math.toRadians(-30),
      roll: 0.0,
    },
  },
  nyc: {
    destination: geo.cartesian3.fromDegrees(-73.9857, 40.7484, 1200),
    orientation: {
      heading: geo.math.toRadians(-20),
      pitch: geo.math.toRadians(-30),
      roll: 0.0,
    },
  },
};

/**
 * Fly the camera to a preset location with a smooth animation.
 * @param {import('./globe/contract.js').GlobeEngine | object} engine The globe
 *   engine, or a viewer registered for one.
 */
export function flyToPreset(engine, presetName, duration = 3.0) {
  const preset = CAMERA_PRESETS[presetName];
  const camera = engineFromViewer(engine)?.camera;
  if (!preset || !camera) return;

  camera.flyTo({
    destination: preset.destination,
    orientation: preset.orientation,
    duration,
    easing: 'cubicInOut',
  });
}

/**
 * Set camera to Austin on load with a cinematic fly-in.
 * @param {import('./globe/contract.js').GlobeEngine | object} target The globe
 *   engine, or a viewer registered for one.
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToAustin(target) {
  const engine = engineFromViewer(target);
  if (!engine) return () => {};
  // Start from a high altitude, then fly down
  engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(-97.7431, 30.2672, 25000),
    orientation: {
      heading: geo.math.toRadians(0),
      pitch: geo.math.toRadians(-90),
      roll: 0.0,
    },
  });

  // Cinematic fly-in after a brief pause
  const timer = setTimeout(() => {
    if (engine.isDestroyed()) return;
    engine.camera.flyTo({
      destination: geo.cartesian3.fromDegrees(-97.7431, 30.2672, 600),
      orientation: {
        heading: geo.math.toRadians(15),
        pitch: geo.math.toRadians(-30),
        roll: 0.0,
      },
      duration: 4.0,
      easing: 'cubicInOut',
    });
  }, 500);
  return () => {
    clearTimeout(timer);
    if (!engine.isDestroyed()) engine.camera.cancelFlight();
  };
}
