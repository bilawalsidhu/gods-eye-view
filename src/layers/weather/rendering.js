import { weatherTileUrl, weatherImageUrl } from './source.js';

const observationOrder = new WeakMap();

/** Own at most a displayed and a staging frame. Use native Cesium tile scheduling,
 * projection and texture disposal; the application clock is never touched. */
export function createWeatherRendering({
  viewer,
  cesium,
  onChange = () => {},
  timeoutMs = 25_000,
}) {
  const collection = viewer.imageryLayers;
  let current = null;
  let incoming = null;
  let alpha = 0.7;
  let lastError = null;

  function remove(frame) {
    if (!frame) return;
    frame.closed = true;
    frame.offError?.();
    frame.offAbort?.();
    frame.offRender?.();
    clearTimeout(frame.timeout);
    for (const request of frame.requests) request.cancel?.();
    frame.requests.clear();
    if (!collection.isDestroyed?.() && collection.contains(frame.layer))
      collection.remove(frame.layer, true);
  }
  function cancelIncoming() {
    if (!incoming) return;
    const previous = incoming;
    incoming = null;
    remove(previous);
    previous.resolve(false);
  }
  return {
    async setFrame(snapshot, time, { signal } = {}) {
      signal?.throwIfAborted();
      cancelIncoming();
      if (current?.time === time && current.product === snapshot.product)
        return true;
      lastError = null;
      const { west, south, east, north } = snapshot.bounds;
      const rectangle = cesium.Rectangle.fromDegrees(west, south, east, north);
      const global = snapshot.product === 'clouds';
      // NOAA's global reflectance changes contrast with the request extent.
      // One bounded full-mosaic image avoids artificial tile-brightness seams.
      // UrlTemplate retains Cesium's native Request cancellation and textures.
      const provider = new cesium.UrlTemplateImageryProvider({
        url: global
          ? weatherImageUrl(time)
          : weatherTileUrl(snapshot.product, time),
        tilingScheme: new cesium.GeographicTilingScheme(
          global
            ? {
                rectangle,
                numberOfLevelZeroTilesX: 1,
                numberOfLevelZeroTilesY: 1,
              }
            : undefined,
        ),
        rectangle,
        tileWidth: global ? 2048 : 256,
        tileHeight: global ? 1024 : 256,
        maximumLevel: global ? 0 : 6,
        enablePickFeatures: false,
        credit: new cesium.Credit(
          snapshot.product === 'radar'
            ? 'NOAA nowCOAST · NWS/OAR MRMS'
            : 'NOAA nowCOAST · NESDIS GOES / global satellite partners',
          true,
        ),
      });
      const frame = {
        time,
        product: snapshot.product,
        requests: new Set(),
        pending: 0,
        closed: false,
        failed: false,
        resolve: null,
      };
      const requestImage = provider.requestImage.bind(provider);
      provider.requestImage = (x, y, level, request) => {
        if (frame.closed) return undefined;
        const result = requestImage(x, y, level, request);
        if (!result) return result; // Cesium's scheduler will retry deferred tiles.
        frame.pending++;
        if (request) frame.requests.add(request);
        return Promise.resolve(result).finally(() => {
          frame.pending--;
          frame.requests.delete(request);
        });
      };
      frame.offError = provider.errorEvent.addEventListener(() => {
        if (frame.closed) return;
        frame.failed = true;
        lastError = 'Some weather tiles unavailable';
        onChange();
      });
      // A shown, transparent layer lets Cesium request staging tiles while the last
      // complete observation stays visible underneath it.
      frame.layer = collection.addImageryProvider(provider);
      frame.layer.alpha = 0;
      observationOrder.set(frame.layer, snapshot.product === 'radar' ? 1 : 0);
      // Satellite context stays beneath radar regardless of toggle order.
      for (let i = collection.length - 1; i > 0; i--) {
        const upper = collection.get(i),
          lower = collection.get(i - 1);
        if (
          observationOrder.has(upper) &&
          observationOrder.has(lower) &&
          observationOrder.get(upper) < observationOrder.get(lower)
        )
          collection.lower(upper);
      }
      incoming = frame;
      const result = new Promise((resolve) => {
        frame.resolve = resolve;
      });
      const finish = (ok) => {
        if (incoming !== frame) return;
        incoming = null;
        frame.offRender?.();
        frame.offRender = null;
        clearTimeout(frame.timeout);
        frame.offAbort?.();
        if (ok) {
          lastError = null;
          remove(current);
          current = frame;
          frame.layer.alpha = alpha;
        } else {
          lastError = 'Weather tiles unavailable · previous frame retained';
          remove(frame);
        }
        frame.resolve(ok);
        viewer.scene.requestRender();
        onChange();
      };
      const abort = () => {
        if (incoming === frame) cancelIncoming();
        viewer.scene.requestRender();
      };
      signal?.addEventListener('abort', abort, { once: true });
      frame.offAbort = () => signal?.removeEventListener('abort', abort);
      let settled = 0;
      frame.offRender = viewer.scene.postRender.addEventListener(() => {
        if (frame.failed) return finish(false);
        if (viewer.scene.globe.tilesLoaded && frame.pending === 0) {
          if (++settled >= 2) finish(true);
          else viewer.scene.requestRender();
        } else settled = 0;
      });
      frame.timeout = setTimeout(() => finish(false), timeoutMs);
      viewer.scene.requestRender();
      onChange();
      return result;
    },
    setAlpha(value) {
      alpha = value;
      if (current) current.layer.alpha = alpha;
      viewer.scene.requestRender();
    },
    clear() {
      cancelIncoming();
      remove(current);
      current = null;
      lastError = null;
      viewer.scene.requestRender();
    },
    getDiagnostics() {
      return {
        imageryCount: Number(!!current) + Number(!!incoming),
        loading: !!incoming,
        time: current?.time ?? null,
        product: current?.product ?? null,
        pendingTiles: incoming?.pending ?? 0,
        error: lastError,
      };
    },
  };
}
