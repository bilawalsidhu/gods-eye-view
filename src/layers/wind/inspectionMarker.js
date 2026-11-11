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
  engine,
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
    engine.render.request('wind-inspection');
  };
  return {
    show(position) {
      clear();
      const canvas = engine.host.canvas;
      const frames = engine.frames.postRender;
      if (
        !position ||
        !container?.ownerDocument ||
        !frames?.addEventListener ||
        !engine.projector
      )
        return;
      present({ owner, container, visible: false, left: 0, top: 0 });
      const render = () => {
        if (!shown()) return;
        const point = engine.projector.worldToWindow(position, {});
        const visible =
          point &&
          point.x >= 0 &&
          point.y >= 0 &&
          point.x <= canvas.clientWidth &&
          point.y <= canvas.clientHeight &&
          engine.projector.horizonVisible(position);
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
      engine.render.request('wind-inspection');
    },
    clear,
    destroy: clear,
  };
}
