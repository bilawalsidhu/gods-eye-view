import { createFakeEngine } from '../globe/testing/fakeEngine.js';

/** A globe camera that follows the pose and events of a viewer test double. */
export function viewerEngine(viewer) {
  const camera = viewer.camera;
  const engine = createFakeEngine();
  const initialPose = engine.camera.pose.bind(engine.camera);
  engine.camera.pose = () => ({
    ...initialPose(),
    cartographic: camera.positionCartographic,
    heading: camera.heading ?? 0,
    pitch: camera.pitch ?? 0,
    roll: camera.roll ?? 0,
  });
  engine.camera.viewRectangle = () => camera.computeViewRectangle?.();
  for (const event of ['moveStart', 'moveEnd', 'changed']) {
    if (camera[event]) engine.camera[event] = camera[event];
  }
  if (camera.flyTo) engine.camera.flyTo = camera.flyTo.bind(camera);
  if (camera.setView) engine.camera.setView = camera.setView.bind(camera);
  return engine;
}

/**
 * A globe engine whose follow is a viewer test double's tracked entity, as
 * the Cesium engine reports one the app tracked: following() is
 * `{ native: entity }` and followChanged is the viewer's
 * trackedEntityChanged.
 */
export function trackingEngine(viewer) {
  const engine = createFakeEngine();
  engine.camera.following = () =>
    viewer.trackedEntity ? { native: viewer.trackedEntity } : null;
  Object.defineProperty(engine.camera, 'followChanged', {
    value: viewer.trackedEntityChanged,
  });
  return engine;
}

/**
 * A globe engine with only the camera of a viewer test double: its pose at
 * the double's positionCartographic and its view rectangle. It has no canvas
 * (screen picks miss) and no surface (ground heights are 0).
 */
export function cameraOnlyEngine(viewer) {
  const camera = viewer?.camera;
  return {
    camera: {
      pose: () => ({ cartographic: camera?.positionCartographic }),
      viewRectangle: () => camera?.computeViewRectangle?.(),
    },
    host: { size: () => ({ width: 0, height: 0 }) },
  };
}
