import { sampleScalar } from '../wind/fields.js';

/**
 * Physical anchors keep the neutral stop exactly freezing in either display
 * unit. Warm stops sit 10 °C apart so temperate, subtropical and tropical air
 * read as green, yellow and orange rather than one band.
 */
export const TEMPERATURE_STOPS = Object.freeze([
  { value: -40, color: '#3b0f70' },
  { value: -25, color: '#2c5bd6' },
  { value: -10, color: '#39b8e0' },
  { value: 0, color: '#e9f5ee' },
  { value: 10, color: '#8fcf5a' },
  { value: 20, color: '#f4cf3a' },
  { value: 30, color: '#ec6a25' },
  { value: 45, color: '#9e0b3b' },
]);
const colors = TEMPERATURE_STOPS.map(({ color }) =>
  color.match(/\w\w/g).map((v) => parseInt(v, 16)),
);

export function temperatureColor(value) {
  if (value <= TEMPERATURE_STOPS[0].value) return colors[0];
  if (value >= TEMPERATURE_STOPS[TEMPERATURE_STOPS.length - 1].value)
    return colors[TEMPERATURE_STOPS.length - 1];

  for (let i = 0; i < TEMPERATURE_STOPS.length - 1; i++) {
    const lower = TEMPERATURE_STOPS[i];
    const upper = TEMPERATURE_STOPS[i + 1];
    if (value >= lower.value && value <= upper.value) {
      const p = (value - lower.value) / (upper.value - lower.value);
      return colors[i].map((v, channel) =>
        Math.round(v + (colors[i + 1][channel] - v) * p),
      );
    }
  }
  return colors[0];
}

/** Wind's seam-safe bilinear sampler, with no vector field or particles. */
export const sampleTemperature = (snapshot, lon, lat) =>
  sampleScalar(snapshot, lon, lat, 'temperature');

export function createTemperatureRaster(
  snapshot,
  { width = 360, height = 181 } = {},
) {
  if (
    !snapshot?.scalar ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > 720 ||
    height > 362
  )
    return null;
  const rgba = new Uint8ClampedArray(width * height * 4);
  let finite = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = sampleTemperature(
        snapshot,
        -180 + ((x + 0.5) / width) * 360,
        90 - ((y + 0.5) / height) * 180,
      );
      if (value === null) continue;
      rgba.set([...temperatureColor(value), 255], (y * width + x) * 4);
      finite++;
    }
  }
  return finite ? { width, height, rgba } : null;
}
