/**
 * @module render/cesium/drawingBuffer
 * @description Keeps a Cesium widget's drawing buffer inside the GPU's
 * framebuffer limit, whoever sets its `resolutionScale` (the quality port's
 * `pixelRatio`, or no one).
 *
 * Cesium sizes the canvas to its CSS size times `pixelRatio` in `resize()`,
 * and throws "Width must be less than or equal to the maximum texture size"
 * on the next draw when a side is over the limit; the render loop stops
 * (#905). The guard keeps the scale asked for and applies the largest scale
 * at or under it that fits, before each resize, so a window grown past the
 * limit is in bounds on its first frame.
 *
 * It also keeps Cesium's nearest-neighbour upscaling only where it is exact:
 * at a whole-number factor between the screen's pixels and the drawing
 * buffer's. At a fractional one (1.5 on a 2x screen) it doubles every third
 * row, so the browser filters instead.
 */

/**
 * The largest scale at or under `scale` whose drawing buffer fits `maxSide`.
 * @param {number} scale The scale asked for.
 * @param {number} longerSide The canvas's longer side, CSS pixels.
 * @param {number} basePixelRatio Drawing pixels per CSS pixel at scale 1.
 * @param {number} maxSide The GPU's limit for a framebuffer side; 0 skips it.
 */
export function fittedScale(scale, longerSide, basePixelRatio, maxSide) {
  if (!(maxSide > 0) || !(longerSide > 0) || !(basePixelRatio > 0))
    return scale;
  return Math.min(scale, maxSide / (longerSide * basePixelRatio));
}

/**
 * Guard `widget` (a `CesiumWidget`). Reading `resolutionScale` gives the
 * scale asked for; Cesium draws at the fitted one.
 * @param {object} widget
 * @param {{maxSide?: number, windowRef?: {devicePixelRatio?: number}}} [options]
 *   `maxSide` is the GPU's limit for a framebuffer side.
 * @returns {() => void} Restores Cesium's own `resize` and scale.
 */
export function fitDrawingBuffer(
  widget,
  { maxSide = 0, windowRef = globalThis.window } = {},
) {
  const scaleProperty = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(widget),
    'resolutionScale',
  );
  if (typeof widget?.resize !== 'function' || !scaleProperty?.set)
    throw new TypeError('fitDrawingBuffer requires a CesiumWidget');
  const canvas = widget.canvas;
  const style = canvas?.style;
  const crisp = style?.imageRendering || '';
  let asked = scaleProperty.get.call(widget);

  const fit = () => {
    const dpr = Number(windowRef?.devicePixelRatio) || 1;
    const base = widget.useBrowserRecommendedResolution ? 1 : dpr;
    const side = Math.max(canvas?.clientWidth || 0, canvas?.clientHeight || 0);
    const scale = fittedScale(asked, side, base, maxSide);
    // Cesium's setter forces the next resize when the scale changes.
    scaleProperty.set.call(widget, scale);
    if (style)
      style.imageRendering = Number.isInteger(dpr / (base * scale))
        ? crisp
        : 'auto';
  };

  Object.defineProperty(widget, 'resolutionScale', {
    configurable: true,
    enumerable: scaleProperty.enumerable,
    get: () => asked,
    set(value) {
      asked = value;
      fit();
    },
  });
  const resize = widget.resize;
  const resizeInBounds = function () {
    fit();
    return resize.call(this);
  };
  widget.resize = resizeInBounds;
  fit();

  return () => {
    if (widget.resize === resizeInBounds) widget.resize = resize;
    delete widget.resolutionScale;
    scaleProperty.set.call(widget, asked);
    if (style) style.imageRendering = crisp;
  };
}
