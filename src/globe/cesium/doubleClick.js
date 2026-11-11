import * as Cesium from 'cesium';

/**
 * Take the viewer's double-click through `handle` first. Cesium's Viewer
 * installs its own (pickAndTrackObject), which untracks whenever the pick is
 * not an Entity: on a followed aircraft's model, a primitive, it would drop
 * the very track the double-click means to ride. A double-click `handle`
 * claims (returns true) stops there; any other goes on to Cesium's.
 * @param {object} viewer
 * @param {(position: {x: number, y: number}|undefined) => boolean} handle
 * @returns {() => void} Puts Cesium's handler back, unless another owner
 *   (the draw tool borrows it) has replaced ours since.
 */
export function routeViewerDoubleClick(viewer, handle) {
  const handler = viewer.screenSpaceEventHandler;
  if (typeof handler?.setInputAction !== 'function') return () => {};
  const type = Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK;
  const stock = handler.getInputAction?.(type) ?? null;
  const routed = (event) => {
    if (handle(event?.position)) return;
    stock?.(event);
  };
  handler.setInputAction(routed, type);
  return () => {
    if (handler.isDestroyed?.() || handler.getInputAction?.(type) !== routed)
      return;
    if (stock) handler.setInputAction(stock, type);
    else handler.removeInputAction(type);
  };
}
