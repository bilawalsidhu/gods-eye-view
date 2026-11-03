import * as Cesium from 'cesium';
import { DURBAN } from './places.js';

// Immediate positioning avoids a delayed startup flight stealing a user's camera.
export function flyToDurban(viewer) {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      DURBAN.longitude,
      DURBAN.latitude,
      18000,
    ),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
  return () => {
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}
