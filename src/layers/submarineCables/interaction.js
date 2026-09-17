import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';

export function createInteraction({ state, screenSpaceEventHandlerFactory }) {
  function registerPickEntity(entity, info) {
    entity.__gevTeleGeography = info;
    state._pickByEntity.set(entity, info);
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
    if (!picked) return null;
    const primitive = picked.primitive;
    if (primitive) {
      const primitiveInfo = state._pickByEntity.get(primitive);
      if (primitiveInfo) return primitiveInfo;
      if (primitive.__gevTeleGeography) return primitive.__gevTeleGeography;
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
      const entityInfo = state._pickByEntity.get(entity);
      if (entityInfo) return entityInfo;
      if (entity.__gevTeleGeography) return entity.__gevTeleGeography;
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
