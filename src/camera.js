import * as geo from './geo/index.js';

/**
 * Set camera to Austin on load with a cinematic fly-in.
 * @param {import('./globe/contract.js').GlobeEngine | null} engine
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToAustin(engine) {
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
