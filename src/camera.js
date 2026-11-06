import { toRadians } from './geo/index.js';
import { cameraOf } from './render/rendererOf.js';

/**
 * Set camera to Austin on load with a cinematic fly-in.
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToAustin(viewer) {
  const camera = cameraOf(viewer);
  // Start from a high altitude, then fly down
  camera.setView({
    destination: { lon: -97.7431, lat: 30.2672, height: 25000 },
    orientation: { heading: 0, pitch: toRadians(-90), roll: 0 },
  });

  // Cinematic fly-in after a brief pause
  let flight = null;
  const timer = setTimeout(() => {
    if (viewer.isDestroyed()) return;
    flight = camera.flyTo(
      { lon: -97.7431, lat: 30.2672, height: 600 },
      {
        orientation: { heading: toRadians(15), pitch: toRadians(-30), roll: 0 },
        durationS: 4.0,
        easing: 'cubicInOut',
      },
    );
  }, 500);
  return () => {
    clearTimeout(timer);
    // Only the fly-in: a flight the user started since is theirs.
    if (!viewer.isDestroyed()) flight?.cancel();
  };
}
