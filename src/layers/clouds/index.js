import * as Cesium from 'cesium';

/** Return the opacity associated with a cloud display level. */
export function cloudsAlpha(level) {
  return { low: 0.35, medium: 0.6, high: 0.85 }[level] ?? 0.6;
}

/** Summarize available imagery in a cloud manifest. */
export function cloudStats(manifest) {
  const sources = Array.isArray(manifest?.sources) ? manifest.sources : [];
  const available = sources.filter(
    (source) =>
      !source.unavailable && Array.isArray(source.parts) && source.parts.length,
  );
  const lastUpdate = available.length
    ? Math.max(
        ...available.map(
          (source) => source.observationTime ?? manifest.fetchedAt ?? 0,
        ),
      )
    : null;
  return {
    count: available.length,
    lastUpdate,
    error: available.length
      ? null
      : sources[0]?.reason || 'Cloud imagery unavailable',
  };
}

/** Create a GOES imagery layer managed by the application lifecycle. */
export function createCloudsLayer({
  feed,
  cesium = Cesium,
  services,
  alpha,
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Clouds require a snapshot source');
  let viewer = null;
  let enabled = false;
  let request = null;
  let generation = 0;
  let owned = [];
  let manifest = null;
  let guidance = null;
  let opacity = typeof alpha === 'number' ? alpha : cloudsAlpha('medium');
  let product = 'GEOCOLOR';
  const products = [
    ['GEOCOLOR', 'GeoColor'],
    ['ABI13', 'ABI 13 infrared'],
    ['ABI2', 'ABI 2 visible'],
  ];

  const removeOwned = () => {
    if (viewer?.imageryLayers)
      for (const layer of owned) viewer.imageryLayers.remove(layer);
    owned = [];
  };
  const layer = {
    id: 'clouds',
    name: 'Cloud Cover',
    icon: '☁',
    source: 'NOAA GOES',
    updateInterval: 60000,
    init(nextViewer) {
      viewer = nextViewer;
      owned = [];
      enabled = false;
      manifest = null;
      guidance = null;
    },
    enable() {
      enabled = true;
    },
    disable() {
      request?.abort();
      request = null;
      enabled = false;
      removeOwned();
    },
    setAlpha(level) {
      opacity = typeof level === 'number' ? level : cloudsAlpha(level);
      for (const item of owned) item.alpha = opacity;
    },
    async update(nextViewer, { signal } = {}) {
      if (!enabled) return false;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const combined =
        signal && AbortSignal.any
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal;
      const current = ++generation;
      if (nextViewer) viewer = nextViewer;
      try {
        if (viewer?.scene?.globe?.show === false) {
          removeOwned();
          guidance = 'Cloud imagery requires Satellite or OSM map';
          return true;
        }
        const nextManifest = await feed.getSnapshot({
          signal: combined,
          product,
        });
        if (
          combined.aborted ||
          request !== controller ||
          !enabled ||
          current !== generation
        )
          return false;
        const nextLayers = [];
        for (const source of nextManifest.sources) {
          if (source.unavailable || !Array.isArray(source.parts)) continue;
          for (const part of source.parts) {
            if (
              combined.aborted ||
              request !== controller ||
              !enabled ||
              current !== generation
            )
              return false;
            try {
              const provider = await cesium.SingleTileImageryProvider.fromUrl(
                part.url,
                {
                  rectangle: cesium.Rectangle.fromDegrees(
                    part.rectangle.west,
                    part.rectangle.south,
                    part.rectangle.east,
                    part.rectangle.north,
                  ),
                },
              );
              if (
                combined.aborted ||
                request !== controller ||
                !enabled ||
                current !== generation
              )
                return false;
              const imagery = viewer.imageryLayers.addImageryProvider(provider);
              imagery.alpha = opacity;
              nextLayers.push(imagery);
            } catch (error) {
              console.warn('[Data:Clouds] Imagery part failed:', error);
            }
          }
        }
        const previous = owned;
        owned = nextLayers;
        manifest = nextManifest;
        guidance = null;
        for (const item of previous) viewer.imageryLayers.remove(item);
        return true;
      } catch (error) {
        if (combined.aborted || request !== controller || !enabled)
          return false;
        guidance = error?.message || 'Cloud imagery unavailable';
        // A first failure is non-fatal: report truthful unavailable stats so the
        // enabled layer keeps retrying instead of being torn down.
        return true;
      } finally {
        if (request === controller) request = null;
      }
    },
    setParams(params = {}) {
      if (['GEOCOLOR', 'ABI13', 'ABI2'].includes(params.product)) {
        product = params.product;
        generation++;
        request?.abort();
        this._rowControlsListener?.();
        return true;
      }
      return false;
    },
    getRowControls() {
      return {
        chips: products.map(([id, label]) => ({
          id,
          label,
          active: product === id,
          params: { product: id },
        })),
        info: 'STAR CDN JPEG products; infrared is an approximate display proxy.',
      };
    },
    setRowControlsListener(listener) {
      this._rowControlsListener = listener;
    },
    destroy() {
      request?.abort();
      request = null;
      enabled = false;
      removeOwned();
      viewer = null;
      manifest = null;
      guidance = null;
      generation++;
    },
    getStats() {
      if (!manifest) return { count: 0, lastUpdate: null, error: guidance };
      const stats = cloudStats(manifest);
      return { ...stats, error: guidance || stats.error };
    },
    getOwnedLayerCount() {
      return owned.length;
    },
  };
  return layer;
}
