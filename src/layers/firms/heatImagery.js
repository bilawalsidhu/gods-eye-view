/**
 * Drapes the Active Fires heat raster over the globe as one full-extent
 * imagery tile on the active imagery host (globe or 3D-tiles), like the wind
 * layer's scalar field. Owns the canvas and the imagery layer; nothing else
 * in the fires layer touches imagery.
 */

const defaultCanvas = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

export function createHeatImagery({
  cesium,
  getHost,
  createCanvas = defaultCanvas,
}) {
  let raster = null;
  let layer = null;
  let collection = null;
  let show = true;

  function detach() {
    if (layer && collection) collection.remove(layer, true);
    layer = null;
    collection = null;
  }

  function attach() {
    detach();
    if (!raster) return;
    const host = getHost?.() ?? { collection: null, kind: 'none' };
    if (!host.collection) return;
    const canvas = createCanvas(raster.width, raster.height);
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(raster.width, raster.height);
    image.data.set(raster.rgba);
    ctx.putImageData(image, 0, 0);
    const provider = new cesium.SingleTileImageryProvider({
      url: canvas.toDataURL('image/png'),
      tileWidth: raster.width,
      tileHeight: raster.height,
      rectangle: cesium.Rectangle.MAX_VALUE,
    });
    collection = host.collection;
    layer = collection.addImageryProvider(provider);
    layer.show = show;
    collection.raiseToTop?.(layer);
  }

  return {
    setRaster(next) {
      raster = next;
      attach();
    },
    /** True once a raster was handed over (painted or waiting for a host). */
    hasRaster() {
      return raster !== null;
    },
    setShow(value) {
      show = Boolean(value);
      if (layer) layer.show = show;
    },
    rehome() {
      const host = getHost?.();
      if ((host?.collection ?? null) !== collection) attach();
    },
    destroy() {
      detach();
      raster = null;
    },
  };
}
