import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';

export function createInteraction({ state, screenSpaceEventHandlerFactory }) {
  /** Every drawn part carries its own record as the Cesium pick id. */
  function registerPick(info) {
    state._pickRecords.add(info);
    return info;
  }

  function beginInteraction(viewer) {
    if (state._clickHandler) return;
    state._clickHandler = screenSpaceEventHandlerFactory(viewer.scene.canvas);
    state._clickHandler.setInputAction((click) => {
      // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
      if (!isPointerFree()) return;
      if (!state._enabled) return;
      const picked = viewer.scene.pick(click.position);
      const record = resolvePickRecord(picked);
      if (!record?.reference) return;
      flyToReference(viewer, record.reference);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function resolvePickRecord(picked) {
    const info = picked?.id;
    return info && state._pickRecords.has(info) ? info : null;
  }

  function flyToReference(viewer, reference) {
    if (!viewer || !reference) return;
    const destination = Cesium.Cartesian3.fromDegrees(
      reference.lon,
      reference.lat,
      6500,
    );
    viewer.camera.cancelFlight();
    viewer.camera.flyTo({
      destination,
      orientation: {
        heading: viewer.camera.heading || 0,
        pitch: Cesium.Math.toRadians(-52),
        roll: 0,
      },
      duration: 1.35,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }
  return {
    registerPick,
    beginInteraction,
    resolvePickRecord,
    flyToReference,
  };
}
