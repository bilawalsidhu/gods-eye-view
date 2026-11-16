import { useWindInspectionStore } from '../../ui/stores/windInspection.js';
import { applicationPinia } from '../../ui/vueRuntime.js';
import { canvasOf, findFrame, findQuery } from '../../render/rendererOf.js';

/**
 * One passive marker for the captured location; it never samples on camera
 * movement. Where the point falls, as the renderer's query port projects
 * it, is presented to the wind inspection store after every rendered frame,
 * and the scene chrome renders the marker in `container`. A point beyond
 * the ellipsoid's horizon or off the canvas hides the marker.
 */
export function createWindInspectionMarker({
  container,
  viewer,
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
    if (viewer) findFrame(viewer)?.requestRender('wind inspection marker');
  };
  return {
    show(position) {
      clear();
      const canvas = canvasOf(viewer);
      const query = viewer ? findQuery(viewer) : null;
      const frame = viewer ? findFrame(viewer) : null;
      if (!position || !container?.ownerDocument || !canvas || !query || !frame)
        return;
      present({ owner, container, visible: false, left: 0, top: 0 });
      const render = () => {
        if (!shown()) return;
        const point = query.project(position);
        const visible =
          point &&
          point.x >= 0 &&
          point.y >= 0 &&
          point.x <= canvas.clientWidth &&
          point.y <= canvas.clientHeight &&
          !query.isOccluded(position);
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
      removeRender = frame.on('postRender', render);
      render();
      frame.requestRender('wind inspection marker');
    },
    clear,
    destroy: clear,
  };
}
