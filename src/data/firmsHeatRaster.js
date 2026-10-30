/**
 * Snap Map–style heat raster for the Active Fires far-zoom bands: detections
 * are binned on an equirectangular grid (row 0 = north, column 0 = 180°W),
 * blurred, normalized on a log scale and mapped through HEAT_PALETTE. Pure:
 * no Cesium, no DOM, so the whole pipeline is unit-tested in node.
 */

/** Below this normalized heat nothing is painted: empty land stays empty. */
export const HEAT_FLOOR = 0.03;

export const HEAT_PALETTE = Object.freeze([
  { at: 0.0, rgb: [43, 108, 255], alpha: 0 },
  { at: 0.08, rgb: [43, 108, 255], alpha: 0.35 },
  { at: 0.25, rgb: [25, 195, 255], alpha: 0.55 },
  { at: 0.45, rgb: [47, 224, 122], alpha: 0.65 },
  { at: 0.65, rgb: [245, 230, 66], alpha: 0.75 },
  { at: 0.82, rgb: [255, 138, 31], alpha: 0.82 },
  { at: 1.0, rgb: [255, 42, 26], alpha: 0.88 },
]);

export function heatColorAt(t) {
  if (!(t > HEAT_FLOOR)) return [0, 0, 0, 0];
  const v = Math.min(1, t);
  let i = 1;
  while (i < HEAT_PALETTE.length - 1 && HEAT_PALETTE[i].at < v) i += 1;
  const a = HEAT_PALETTE[i - 1];
  const b = HEAT_PALETTE[i];
  const k = (v - a.at) / (b.at - a.at || 1);
  const mix = (p, q) => Math.round(p + (q - p) * k);
  return [
    mix(a.rgb[0], b.rgb[0]),
    mix(a.rgb[1], b.rgb[1]),
    mix(a.rgb[2], b.rgb[2]),
    Math.round((a.alpha + (b.alpha - a.alpha) * k) * 255),
  ];
}

/** Weight of a detection with no or zero FRP, in megawatts. */
export const HEAT_MIN_WEIGHT_MW = 0.5;

/**
 * Heat is radiated power, not a head count: each detection adds its FRP in
 * megawatts. Weak fires carry little power, so raising the minimum-FRP slider
 * removes most detections without dimming the areas where strong fires burn
 * (a count-based heat collapsed there and the hot spots faded).
 */
const defaultWeight = (fire) =>
  Math.max(HEAT_MIN_WEIGHT_MW, Number(fire.frp) || 0);

export function binFires(fires, { width, height, weight = defaultWeight }) {
  const grid = new Float32Array(width * height);
  for (const fire of fires) {
    if (!Number.isFinite(fire.lat) || !Number.isFinite(fire.lon)) continue;
    const x = Math.min(
      width - 1,
      Math.max(0, Math.floor(((fire.lon + 180) / 360) * width)),
    );
    const y = Math.min(
      height - 1,
      Math.max(0, Math.floor(((90 - fire.lat) / 180) * height)),
    );
    grid[y * width + x] += weight(fire);
  }
  return grid;
}

function kernel(sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    k[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += k[i + radius];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return { k, radius };
}

export function blurGaussian(grid, width, height, sigma) {
  const { k, radius } = kernel(sigma);
  const tmp = new Float32Array(grid.length);
  const out = new Float32Array(grid.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const v = grid[row + x];
      if (v === 0) continue;
      for (let i = -radius; i <= radius; i++) {
        const xx = (((x + i) % width) + width) % width; // longitude wraps
        tmp[row + xx] += v * k[i + radius];
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = tmp[y * width + x];
      if (v === 0) continue;
      for (let i = -radius; i <= radius; i++) {
        const yy = Math.min(height - 1, Math.max(0, y + i)); // poles clamp
        out[yy * width + x] += v * k[i + radius];
      }
    }
  }
  return out;
}

/** Bins of the log-density histogram used to find the reference quantile. */
const QUANTILE_BINS = 4096;

/**
 * The p-quantile of the non-zero values, from a histogram of log1p(value):
 * one linear pass instead of sorting ~350k burning pixels (a sort cost
 * 200 ms+ and dominated the build). Bin width on the log axis is
 * max/4096, far finer than the 256-step palette it feeds.
 */
function percentileOfNonZero(values, p) {
  let count = 0;
  let max = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v > 0) {
      count += 1;
      if (v > max) max = v;
    }
  }
  if (!count) return 0;
  const logMax = Math.log1p(max);
  const bins = new Uint32Array(QUANTILE_BINS);
  const toBin = (QUANTILE_BINS - 1) / logMax;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v > 0) bins[Math.floor(Math.log1p(v) * toBin)] += 1;
  }
  const target = Math.floor(p * (count - 1));
  let seen = 0;
  for (let b = 0; b < QUANTILE_BINS; b++) {
    seen += bins[b];
    if (seen > target) return Math.expm1((b + 1) / toBin);
  }
  return max;
}

/** HEAT_PALETTE sampled at 256 steps, so the per-pixel walk is one lookup. */
const LUT_STEPS = 256;
let paletteLut = null;
function heatLut() {
  if (!paletteLut) {
    paletteLut = new Uint8ClampedArray(LUT_STEPS * 4);
    for (let i = 0; i < LUT_STEPS; i++) {
      paletteLut.set(heatColorAt(i / (LUT_STEPS - 1)), i * 4);
    }
  }
  return paletteLut;
}

export function buildHeatRaster(
  fires,
  { width, height, sigmaPx, percentile = 0.995 },
) {
  const density = blurGaussian(
    binFires(fires, { width, height }),
    width,
    height,
    sigmaPx,
  );
  const reference = percentileOfNonZero(density, percentile);
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (reference > 0) {
    const lut = heatLut();
    const scale = (LUT_STEPS - 1) / Math.log1p(reference);
    for (let i = 0; i < density.length; i++) {
      const d = density[i];
      if (d <= 0) continue;
      const step = Math.min(LUT_STEPS - 1, Math.round(Math.log1p(d) * scale));
      const l = step * 4;
      if (lut[l + 3] === 0) continue;
      const o = i * 4;
      rgba[o] = lut[l];
      rgba[o + 1] = lut[l + 1];
      rgba[o + 2] = lut[l + 2];
      rgba[o + 3] = lut[l + 3];
    }
  }
  return { width, height, rgba, reference };
}
