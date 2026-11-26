/**
 * Drapes the Active Fires heat raster over the globe as one full-extent
 * image on the renderer's imagery (`globe.imagery`, the globe port), like
 * the wind layer's scalar field. It drapes on whatever the map stack draws
 * (the globe's surface, or the 3D tiles). Owns the canvas and the imagery
 * layer; nothing else in the fires layer touches imagery.
 *
 * `show` is only for the layer being on or off. The zoom hand-off fades
 * `alpha` instead: a renderer may unmap a hidden imagery layer from the
 * surface and re-map it when shown, so a show toggle at the band edge left
 * a beat with neither markers nor heat. At alpha 0 the layer stays mapped
 * and costs no draw.
 */

const WORLD = Object.freeze({ west: -180, south: -90, east: 180, north: 90 });

/**
 * Drawn over the port's other imagery (zOrder 0) and under the weather
 * layers (`WEATHER_IMAGERY_Z`, from 0.75 for an air-quality model field),
 * so weather turned on after the heat stacks above it, as each weather
 * frame went on top of the stack.
 */
export const HEAT_IMAGERY_Z = 0.5;

const defaultCanvas = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/**
 * @param {object} options
 * @param {() => {globe: object|null, kind: string}|null} options.getHost
 *   Where draped imagery goes now: the renderer's globe port, and the kind
 *   of surface the active map stack drapes on (`'none'`: nothing to drape
 *   on, so nothing is draped).
 * @param {(width: number, height: number) => object} [options.createCanvas]
 */
export function createHeatImagery({ getHost, createCanvas = defaultCanvas }) {
  let raster = null;
  let layer = null;
  /** The host the layer is draped on: its globe port and kind. */
  let globe = null;
  let kind = 'none';
  let show = true;
  let opacity = 1;

  const hostNow = () => {
    const host = getHost?.();
    return host?.globe && host.kind !== 'none'
      ? host
      : { globe: null, kind: 'none' };
  };

  function detach() {
    layer?.remove();
    layer = null;
    globe = null;
    kind = 'none';
  }

  function attach() {
    detach();
    if (!raster) return;
    const host = hostNow();
    if (!host.globe) return;
    const canvas = createCanvas(raster.width, raster.height);
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(raster.width, raster.height);
    image.data.set(raster.rgba);
    ctx.putImageData(image, 0, 0);
    layer = host.globe.imagery.add({
      kind: 'single-image',
      url: canvas.toDataURL('image/png'),
      rectangle: WORLD,
      zOrder: HEAT_IMAGERY_Z,
    });
    globe = host.globe;
    kind = host.kind;
    layer.show = show;
    layer.alpha = opacity;
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
    /** Drape again when the map stack's surface has changed. */
    rehome() {
      const host = hostNow();
      if (host.globe !== globe || host.kind !== kind) attach();
    },
    destroy() {
      detach();
      raster = null;
    },
  };
}
