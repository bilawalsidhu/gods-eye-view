import { useWindInspectionStore } from '../../ui/stores/windInspection.js';
import { applicationPinia } from '../../ui/vueRuntime.js';

/**
 * One passive marker for the captured location; it never samples on camera
 * movement. Where the point falls is presented to the wind inspection store
 * after every rendered frame, and the scene chrome renders the marker in
 * `container`.
 */
export function createWindInspectionMarker({
  container,
  viewer,
  engine,
  cesium,
  store = useWindInspectionStore(applicationPinia()),
}) {
  const owner = {};
  let removeRender = null;
  let marker = null;
  // Only the owner whose marker the store shows may move or remove it.
  const shown = () => marker && store.marker?.owner === owner;
  const present = (patch) => {
    marker = { ...marker, ...patch };
    store.publish(marker);
  };
  const clear = () => {
    removeRender?.();
    removeRender = null;
    if (shown()) store.publish(null);
    marker = null;
    if (engine) engine.render.request('wind-inspection');
    else viewer?.scene?.requestRender?.();
  };
  return {
    show(position) {
      clear();
      const scene = viewer?.scene;
      const canvas = scene?.canvas ?? engine?.host.canvas;
      const frames = scene?.postRender ?? engine?.frames.postRender;
      if (
        !position ||
        !container?.ownerDocument ||
        !frames?.addEventListener ||
        (!engine?.projector && !scene?.cartesianToCanvasCoordinates)
      )
        return;
      present({ owner, container, visible: false, left: 0, top: 0 });
      const occluder =
        !engine &&
        new cesium.EllipsoidalOccluder(
          scene.globe?.ellipsoid || cesium.Ellipsoid.WGS84,
          viewer.camera.positionWC,
        );
      const render = () => {
        if (!shown()) return;
        if (occluder) occluder.cameraPosition = viewer.camera.positionWC;
        const point = engine
          ? engine.projector.worldToWindow(position, {})
          : scene.cartesianToCanvasCoordinates(position);
        const visible =
          point &&
          point.x >= 0 &&
          point.y >= 0 &&
          point.x <= canvas.clientWidth &&
          point.y <= canvas.clientHeight &&
          (engine
            ? engine.projector.horizonVisible(position)
            : scene.mode !== cesium.SceneMode.SCENE3D ||
              occluder.isPointVisible(position));
        if (!visible) {
          // A hidden marker keeps its last place, as the element did.
          if (marker.visible) present({ visible: false });
          return;
        }
        const canvasRect = canvas.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const left = point.x + canvasRect.left - containerRect.left;
        const top = point.y + canvasRect.top - containerRect.top;
        if (marker.visible && marker.left === left && marker.top === top)
          return;
        present({ visible: true, left, top });
      };
      removeRender = frames.addEventListener(render);
      render();
      if (engine) engine.render.request('wind-inspection');
      else scene.requestRender?.();
    },
    clear,
    destroy: clear,
  };
}
