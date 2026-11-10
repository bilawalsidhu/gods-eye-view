import * as Cesium from 'cesium';

/** Geographic imagery uses latitude-dependent level selection. */
export function isGeographicProjection(projection) {
  return projection instanceof Cesium.GeographicProjection;
}

/** Visible tiles take priority over the orbital view's look-ahead requests. */
export function createOrbitalImageryRequest() {
  return new Cesium.Request({
    throttle: true,
    throttleByServer: true,
    priority: Number.MAX_VALUE,
    type: Cesium.RequestType.IMAGERY,
  });
}

/** Run orbital focus before the viewer's own single-click selection. */
export function routeViewerClick(viewer, handle) {
  const handler = viewer.screenSpaceEventHandler;
  if (typeof handler?.setInputAction !== 'function') return () => {};
  const type = Cesium.ScreenSpaceEventType.LEFT_CLICK;
  const stock = handler.getInputAction?.(type) ?? null;
  const routed = (event) => {
    handle(event?.position);
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
