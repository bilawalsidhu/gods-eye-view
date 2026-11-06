import { createShellSurface } from '../weather/shellRendering.js';
import { NO_IMAGERY_HOST } from '../weather/imageryHost.js';
import { msg } from '../../i18n/index.js';
import { GRAVITY_COLORS } from './display.js';

export { GRAVITY_COLORS };

const IMAGE_UNAVAILABLE = msg('Gravity field image unavailable');

/** Metres above the ellipsoid: under the weather shells, which start at 5 km. */
export const GRAVITY_SHELL_HEIGHT = 4_000;

/** RGBA for a value in centimetres; null (no data) is transparent. */
export function gravityColor(cm) {
  if (cm === null || !Number.isFinite(cm)) return [0, 0, 0, 0];
  const last = GRAVITY_COLORS.length - 1;
  if (cm <= GRAVITY_COLORS[0][0]) return GRAVITY_COLORS[0][1];
  if (cm >= GRAVITY_COLORS[last][0]) return GRAVITY_COLORS[last][1];
  const upper = GRAVITY_COLORS.findIndex(([stop]) => cm <= stop);
  const [aStop, a] = GRAVITY_COLORS[upper - 1];
  const [bStop, b] = GRAVITY_COLORS[upper];
  const t = (cm - aStop) / (bStop - aStop);
  return a.map((channel, index) =>
    Math.round(channel + (b[index] - channel) * t),
  );
}

/** Image pixels per grid cell each way: 0.25°, the land mask's resolution. */
export const GRAVITY_UPSAMPLE = 4;

const LUT_MIN = GRAVITY_COLORS[0][0];
const LUT_MAX = GRAVITY_COLORS.at(-1)[0];
const LUT_STEP = 0.05;
let colorTable = null;
/** Packed RGBA per 0.05 cm across the scale, built once. */
function colorLut() {
  if (colorTable) return colorTable;
  const size = Math.round((LUT_MAX - LUT_MIN) / LUT_STEP) + 1;
  colorTable = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < size; i++)
    colorTable.set(gravityColor(LUT_MIN + i * LUT_STEP), i * 4);
  return colorTable;
}

/**
 * Where each output row or column samples the grid: the two cells either side
 * of the pixel centre and the weight of the second. Rows clamp at the poles;
 * columns wrap at the antimeridian.
 */
function taps(cells, upsample, wrap) {
  const length = cells * upsample;
  const first = new Int32Array(length);
  const second = new Int32Array(length);
  const weight = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const at = (i + 0.5) / upsample - 0.5;
    let low = Math.floor(at);
    let fraction = at - low;
    let high = low + 1;
    if (wrap) {
      low = ((low % cells) + cells) % cells;
      high = high % cells;
    } else if (low < 0) {
      low = high = 0;
      fraction = 0;
    } else if (high >= cells) {
      high = low;
      fraction = 0;
    }
    first[i] = low;
    second[i] = high;
    weight[i] = fraction;
  }
  return { first, second, weight };
}

const coverageCache = new WeakMap();
/**
 * How much land surrounds each mask pixel, 0 to 1: a 1-2-1 blur each way, so
 * a coastline fades over about one pixel instead of stepping at 0.25°. Columns
 * wrap at the antimeridian and rows clamp at the poles, like the field. The
 * mask is static, so each one is blurred once.
 */
function maskCoverage(mask, width, height) {
  const cached = coverageCache.get(mask);
  if (cached) return cached;
  const across = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const left = row + ((x + width - 1) % width);
      const right = row + ((x + 1) % width);
      across[row + x] =
        ((mask[left] === 1) + 2 * (mask[row + x] === 1) + (mask[right] === 1)) /
        4;
    }
  }
  const coverage = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width;
    const down = Math.min(height - 1, y + 1) * width;
    const row = y * width;
    for (let x = 0; x < width; x++)
      coverage[row + x] =
        (across[up + x] + 2 * across[row + x] + across[down + x]) / 4;
  }
  coverageCache.set(mask, coverage);
  return coverage;
}

/**
 * One field as an image at 0.25°: each pixel blends its four nearest grid
 * cells, so the one-degree steps become gradients. This is presentation only;
 * the grid stays the data, and the readout uses the cell itself. Row 0 is
 * north and column 0 starts at 180°W, which is already the shell's image
 * orientation.
 * @param {Int16Array} field Stored counts.
 * @param {{nx: number, ny: number, scaleCm: number, noData: number}} format
 * @param {{mask?: ?Uint8Array, upsample?: number}} [options] `mask` is the
 *   land-only view at the image size (1 is land). Inland pixels draw in full,
 *   open sea not at all, and the coastline fades across about one pixel.
 */
export function createGravityRaster(
  field,
  { nx, ny, scaleCm, noData },
  { mask = null, upsample = GRAVITY_UPSAMPLE } = {},
) {
  const width = nx * upsample;
  const height = ny * upsample;
  if (mask && mask.length !== width * height)
    throw new Error('Gravity mask does not match the image');
  const rows = taps(ny, upsample, false);
  const cols = taps(nx, upsample, true);
  const lut = colorLut();
  const coverage = mask ? maskCoverage(mask, width, height) : null;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const top = rows.first[y] * nx;
    const bottom = rows.second[y] * nx;
    const fy = rows.weight[y];
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      const cover = coverage ? coverage[pixel] : 1;
      if (cover === 0) continue;
      const left = cols.first[x];
      const right = cols.second[x];
      const fx = cols.weight[x];
      let sum = 0;
      let total = 0;
      const add = (count, w) => {
        if (count === noData || w === 0) return;
        sum += count * w;
        total += w;
      };
      add(field[top + left], (1 - fx) * (1 - fy));
      add(field[top + right], fx * (1 - fy));
      add(field[bottom + left], (1 - fx) * fy);
      add(field[bottom + right], fx * fy);
      if (total === 0) continue;
      const cm = Math.min(LUT_MAX, Math.max(LUT_MIN, (sum / total) * scaleCm));
      const entry = Math.round((cm - LUT_MIN) / LUT_STEP) * 4;
      rgba[pixel * 4] = lut[entry];
      rgba[pixel * 4 + 1] = lut[entry + 1];
      rgba[pixel * 4 + 2] = lut[entry + 2];
      rgba[pixel * 4 + 3] = Math.round(lut[entry + 3] * cover);
    }
  }
  return { width, height, rgba };
}

/** One raised shell drawing the selected month. */
export function createGravityRendering({
  viewer,
  cesium,
  getHost,
  createCanvas = () => document.createElement('canvas'),
  createSurface = createShellSurface,
} = {}) {
  let surface = null;
  let raster = null;
  let alpha = 0.85;
  let error = null;
  // Two canvases used in turn: setImage ignores the canvas it already holds,
  // so repainting one in place would never upload the new month.
  const canvases = [];
  let canvasIndex = 0;

  function paint() {
    while (canvases.length < 2) canvases.push(createCanvas());
    const canvas = canvases[canvasIndex++ % 2];
    canvas.width = raster.width;
    canvas.height = raster.height;
    const context = canvas.getContext('2d');
    const image = context.createImageData(raster.width, raster.height);
    image.data.set(raster.rgba);
    context.putImageData(image, 0, 0);
    return canvas;
  }
  function remove() {
    surface?.destroy();
    surface = null;
    viewer.scene?.requestRender?.();
  }
  function show() {
    if (!raster) return;
    if (getHost().kind === 'none') {
      remove();
      error = NO_IMAGERY_HOST;
      return;
    }
    try {
      surface ??= createSurface({
        viewer,
        cesium,
        rectangle: cesium.Rectangle.MAX_VALUE,
        height: GRAVITY_SHELL_HEIGHT,
      });
      surface.setImage(paint());
      surface.setAlpha(alpha);
      error = null;
    } catch (cause) {
      console.warn('[Gravity] field image install failed:', cause);
      remove();
      error = IMAGE_UNAVAILABLE;
    }
    viewer.scene?.requestRender?.();
  }
  return {
    setField(field, format, mask = null) {
      raster = createGravityRaster(field, format, { mask });
      show();
    },
    setAlpha(next) {
      alpha = next;
      surface?.setAlpha(alpha);
    },
    rehome() {
      if (raster && (getHost().kind === 'none') === Boolean(surface)) show();
    },
    clear() {
      raster = null;
      error = null;
      remove();
    },
    destroy() {
      raster = null;
      error = null;
      remove();
      canvases.length = 0;
    },
    getDiagnostics() {
      return { imageryActive: Boolean(surface), error };
    },
  };
}
