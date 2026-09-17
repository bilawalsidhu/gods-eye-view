import { weatherTileUrl, weatherImageUrl } from './source.js';
import { orderWeatherImagery } from './imageryOrder.js';

/** Own at most a displayed and a staging frame. Use native Cesium tile scheduling,
 * projection and texture disposal; the application clock is never touched. */
export function createWeatherRendering({
  viewer,
  cesium,
  onChange = () => {},
  timeoutMs = 25_000,
  now = () => performance.now(),
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
    frame.offCamera?.();
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
        // Verbose source courtesy text belongs in Cesium's attribution popup.
        // Product identity remains visible in the row and Weather summary.
        credit: new cesium.Credit(
          snapshot.product === 'lightning'
            ? 'NOAA/NWS lightning density · derived from Vaisala NLDN/GLD360'
            : snapshot.product === 'radar'
              ? 'NOAA nowCOAST · NWS/OAR MRMS'
              : 'NOAA nowCOAST · NESDIS GOES / global satellite partners',
          false,
        ),
      });
      const frame = {
        time,
        product: snapshot.product,
        requests: new Set(),
        deferred: new Set(),
        pending: 0,
        loaded: 0,
        lastActivity: now(),
        startedAt: now(),
        closed: false,
        failed: false,
        resolve: null,
      };
      const requestImage = provider.requestImage.bind(provider);
      provider.requestImage = (x, y, level, request) => {
        if (frame.closed) return undefined;
        const result = requestImage(x, y, level, request);
        const tileKey = `${level}/${x}/${y}`;
        if (!result) {
          // Scheduler admission is part of readiness, not a successful tile.
          frame.deferred.add(tileKey);
          frame.lastActivity = now();
          return result;
        }
        frame.deferred.delete(tileKey);
        frame.pending++;
        frame.lastActivity = now();
        if (request) frame.requests.add(request);
        return Promise.resolve(result)
          .then((image) => {
            frame.loaded++;
            return image;
          })
          .finally(() => {
            frame.pending--;
            frame.lastActivity = now();
            frame.requests.delete(request);
            if (!frame.closed) viewer.scene.requestRender();
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
      orderWeatherImagery(
        collection,
        frame.layer,
        snapshot.product === 'lightning'
          ? 3
          : snapshot.product === 'radar'
            ? 2
            : 1,
      );
      incoming = frame;
      const result = new Promise((resolve) => {
        frame.resolve = resolve;
      });
      const finish = (ok) => {
        if (incoming !== frame) return;
        incoming = null;
        frame.offRender?.();
        frame.offRender = null;
        frame.offCamera?.();
        frame.offCamera = null;
        clearTimeout(frame.timeout);
        frame.offAbort?.();
        if (ok) {
          lastError = null;
          remove(current);
          current = frame;
          frame.loadMs = now() - frame.startedAt;
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
      frame.offCamera = viewer.camera?.moveEnd?.addEventListener(() => {
        // Tiles abandoned by a previous viewport are no longer admission work.
        frame.deferred.clear();
        frame.lastActivity = now();
        settled = 0;
        viewer.scene.requestRender();
      });
      frame.offRender = viewer.scene.postRender.addEventListener(() => {
        if (frame.failed) return finish(false);
        // Unrelated terrain/basemap work must not indefinitely hold a ready
        // observation. Require successful own tiles and a quiet scheduling
        // interval before admitting a frame when the rest of the globe is busy.
        const ownReady =
          frame.loaded > 0 &&
          frame.deferred.size === 0 &&
          now() - frame.lastActivity >= 200;
        if (
          (viewer.scene.globe.tilesLoaded || ownReady) &&
          frame.pending === 0
        ) {
          if (++settled >= 2) finish(true);
          else viewer.scene.requestRender();
        } else settled = 0;
        if (incoming === frame && frame.pending === 0 && frame.loaded > 0)
          viewer.scene.requestRender();
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
        deferredTiles: incoming?.deferred.size ?? 0,
        loadedTiles: (incoming || current)?.loaded ?? 0,
        frameLoadMs: current?.loadMs ?? null,
        error: lastError,
      };
    },
  };
}
