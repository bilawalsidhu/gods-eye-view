// Camera and aircraft ownership used by the shared first-person controller.
import { routeViewerDoubleClick } from '../globe/cesium/doubleClick.js';

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
      canvasPosition: (world) =>
        viewer.scene.cartesianToCanvasCoordinates(world) ?? null,
      routeDoubleClick: (handle) => routeViewerDoubleClick(viewer, handle),
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
    canvasPosition: (world) => engine.projector.worldToWindow(world) ?? null,
    // Navara has no stock double-click to route around.
    routeDoubleClick: (handle) =>
      engine.input.on('doubleClick', (event) => handle(event.position)),
  };
}
