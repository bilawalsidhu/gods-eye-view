/**
 * Drapes the Active Fires heat raster over the globe as one full-extent
 * imagery tile on the active imagery host (globe or 3D-tiles), like the wind
 * layer's scalar field. Owns the canvas and the imagery layer; nothing else
 * in the fires layer touches imagery.
 *
 * `show` is only for the layer being on or off. The zoom hand-off fades
 * `alpha` instead: Cesium unmaps a hidden imagery layer from the globe
 * tiles and re-maps it when shown, so a show toggle at the band edge left
 * a beat with neither markers nor heat. At alpha 0 the layer stays mapped
 * and costs no draw.
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
  let opacity = 1;

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
    layer.alpha = opacity;
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
    /** Hand-off fade, 0..1; the layer stays mapped at 0. */
    setOpacity(value) {
      opacity = Math.min(1, Math.max(0, Number(value) || 0));
      if (layer) layer.alpha = opacity;
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
