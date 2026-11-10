/** Actual WebGL pixels per CSS pixel, including resource-mode scaling. */
export function aircraftRenderPixelRatio(scene) {
  const width = Number(scene?.canvas?.clientWidth);
  const rendered = Number(scene?.drawingBufferWidth);
  return width > 0 && rendered > 0 && Number.isFinite(rendered / width)
    ? rendered / width
    : 1;
}

/** Cesium Model.minimumPixelSize uses drawing-buffer pixels, not CSS pixels. */
export function aircraftModelPixelSize(scene, cssPixels) {
  return cssPixels * aircraftRenderPixelRatio(scene);
}

const SIZES = [32, 64, 96, 192];
const ENTER = [36, 72, 120];
const LEAVE = [28, 56, 96];

/** Shared atlas rasters near the actual draw size. Hysteresis avoids texture
 * changes on tiny zoom/position movements; no per-aircraft images are created. */
export function selectAircraftIconRaster(renderPixels, previous = 64) {
  if (!Number.isFinite(renderPixels) || renderPixels <= 0) return previous;
  let index = SIZES.indexOf(previous);
  if (index < 0) index = 1;
  while (index < SIZES.length - 1 && renderPixels > ENTER[index]) index++;
  while (index > 0 && renderPixels < LEAVE[index - 1]) index--;
  return SIZES[index];
}
