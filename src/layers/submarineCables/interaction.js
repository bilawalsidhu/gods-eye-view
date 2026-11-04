import * as Cesium from 'cesium';
import { cablePicks } from './pickState.js';

export function createInteraction({ state, inputFor }) {
  function registerPickEntity(entity, info) {
    cablePicks.write(entity).info = info;
  }

  function beginInteraction(viewer) {
    if (state._clickSubscription) return;
    state._clickSubscription = inputFor(viewer).onClick((event) => {
      if (!state._enabled) return;
      const record = resolvePickRecord(event.pick);
      if (!record?.reference) return;
      flyToReference(viewer, record.reference);
    });
  }

  function resolvePickRecord(picked) {
    if (!picked) return null;
    const primitive = picked.primitive;
    if (primitive) {
      const primitiveInfo = cablePicks.read(primitive)?.info;
      if (primitiveInfo) return primitiveInfo;
      if (
        primitive.id &&
        typeof primitive.id === 'object' &&
        primitive.id.reference
      ) {
        return primitive.id;
      }
    }

    const entity = picked.id;
    if (entity) {
      const entityInfo = cablePicks.read(entity)?.info;
      if (entityInfo) return entityInfo;
      if (entity.id && typeof entity.id === 'object' && entity.id.reference) {
        return entity.id;
      }
    }

    return null;
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
    registerPickEntity,
    beginInteraction,
    resolvePickRecord,
    flyToReference,
  };
}
