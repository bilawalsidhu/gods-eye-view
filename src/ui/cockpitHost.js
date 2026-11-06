// Camera and aircraft ownership used by the shared first-person controller.
export function cockpitHost(viewer, engine) {
  if (viewer) {
    return {
      preUpdate: viewer.scene.preUpdate,
      followChanged: viewer.trackedEntityChanged,
      followed: () => viewer.trackedEntity,
      current: () =>
        viewer.trackedEntity?.position ? viewer.trackedEntity : null,
      contains: (entity) => viewer.entities.contains(entity),
      position: (entity, result) =>
        entity.position.getValue(viewer.clock.currentTime, result),
      release: () => {
        viewer.trackedEntity = undefined;
      },
      restore: (entity, refocus) => {
        viewer.trackedEntity = entity;
        refocus(entity);
      },
      camera: viewer.camera,
      cartographic: () => viewer.camera.positionCartographic,
      terrainHeight: (place) => viewer.scene.globe?.getHeight(place),
      surface: viewer.scene,
      inputs: (enabled) => {
        viewer.scene.screenSpaceCameraController.enableInputs = enabled;
      },
    };
  }
  const aircraft = () => {
    const target = engine.camera.following()?.native;
    return target?.resumeAircraftFollow ? target : null;
  };
  return {
    preUpdate: engine.frames.preUpdate,
    followChanged: engine.camera.followChanged,
    followed: aircraft,
    current: aircraft,
    contains: (target) => target.live,
    position: (target) => target.spec.position(),
    release: () => engine.camera.following()?.stop(),
    restore: (target) => target.resumeAircraftFollow(),
    camera: engine.camera,
    cartographic: () => engine.camera.pose().cartographic,
    terrainHeight: (place) => engine.surface.terrainHeight(place),
    surface: engine,
    inputs: (enabled) => engine.input.setCameraInputs(enabled),
  };
}
