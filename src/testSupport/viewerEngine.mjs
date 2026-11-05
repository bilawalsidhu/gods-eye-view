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
