/**
 * Per-field rendering constants for the shared vector-field renderer.
 *
 * The wind layer passes WIND_FIELD_SPEC (today's literal constants); the
 * ocean-currents layer passes OCEAN_FIELD_SPEC. Values that depend on the
 * served field are functions of the field object (`speed` statistics from
 * the manifest), never baked into the spec.
 */
const WHITE = '#ffffff';

export function createFieldSpec(overrides = {}) {
  return Object.freeze({
    calmCutoffMs: 0.15,
    // Median 10 m wind speed of a real GFS snapshot (2026-10-16 12Z f010,
    // 360x181 at 1 deg, 65160 cells) decoded by server/providers/wind/gfs.js.
    // The wind renderer's motion constants are tuned for this median.
    targetMedianMs: 5.836,
    rampMaxMs: () => 30,
    ramp: Object.freeze([WHITE, WHITE, WHITE, WHITE, WHITE]),
    rampGamma: 1,
    ...overrides,
    ...(overrides.ramp ? { ramp: Object.freeze([...overrides.ramp]) } : {}),
  });
}

export const WIND_FIELD_SPEC = createFieldSpec();

export const OCEAN_FIELD_SPEC = createFieldSpec({
  calmCutoffMs: 0.02,
  rampMaxMs: (field) =>
    Math.max(
      0.2,
      1.25 * (Number.isFinite(field?.speed?.p95Ms) ? field.speed.p95Ms : 0),
    ),
  // Teal to amber, luminance increasing, hue falling monotonically.
  ramp: ['#267c92', '#2e9ea8', '#60c496', '#bed664', '#ffc950'],
  rampGamma: 0.55,
});

/** Speed at which the ramp saturates for this field. */
export function fieldRampMax(spec, field) {
  const value = spec.rampMaxMs(field);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

/**
 * (E1): s = targetMedian / max(fieldMedian, 1e-3). A field without speed
 * statistics (every wind manifest) has s = 1, so wind motion is unchanged.
 */
export function fieldSpeedScale(spec, field) {
  const median = field?.speed?.medianMs;
  if (!Number.isFinite(median)) return 1;
  return spec.targetMedianMs / Math.max(median, 1e-3);
}

/**
 * Per-step geographic bound in degrees: 0.75 for global grids (today's
 * constant), span/64 for regional ones so a 16-step half path never exceeds
 * a quarter of the field's longer side.
 */
export function fieldStepCap(field) {
  const span = Math.max(field.nx * field.dx, (field.ny - 1) * field.dy);
  if (!Number.isFinite(span) || span <= 0) return 0.75;
  return Math.min(0.75, span / 64);
}

function parseHex(color) {
  return color.match(/\w\w/g).map((part) => parseInt(part, 16));
}

/** JS mirror of the GLSL fieldRamp(): piecewise-linear over the stops. */
export function rampColor(stops, t) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const position = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(position));
  const fraction = position - index;
  const a = parseHex(stops[index]);
  const b = parseHex(stops[index + 1]);
  return a.map((value, i) => Math.round(value + (b[i] - value) * fraction));
}

/** Stops as 0..1 RGB triples for shader uniforms. */
export function rampStopVectors(stops) {
  return stops.map((color) => parseHex(color).map((value) => value / 255));
}
