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
    // Seeds per whole-sphere bake relative to the wind budget. Fields with a
    // bbox seed inside the box and ignore it.
    globeSeedScale: 1,
    // Boxed fields: summed path length per degree of box width (degrees per
    // degree). null keeps the wind budget for boxes.
    boxLineCoverage: null,
    // GPU streamlines are lifted off the surface for visibility and faded out
    // when the camera gets close enough for that lift to read as parallax.
    displayHeightMeters: 12000,
    fadeLowMeters: 15000,
    fadeHighMeters: 60000,
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
  // 39 percent of the 1 deg lattice is land or no-data and those seeds are
  // dropped, so the wind budget leaves the globe at wind density; 2 x
  // gives about 9100 paths (measured 2026-10-16: 7200 seeds -> 4552 paths).
  globeSeedScale: 2,
  // Tuned from screenshots at the four QA stops (2026-10-16).
  boxLineCoverage: 77,
  // Coastal views sit at 50 to 100 km: a 12 km lift would shift the field by
  // a tenth of its width onto land. Currents hug the sea surface instead.
  displayHeightMeters: 100,
  fadeLowMeters: 300,
  fadeHighMeters: 1200,
});

/**
 * A field is the globe when it has no bbox or its bbox wraps every
 * longitude: the served global manifest carries the lattice extent
 * (-180..180) as its bbox, so a missing bbox alone does not identify it.
 */
export function isGlobeField(field) {
  const bbox = field?.bbox;
  if (!bbox) return true;
  return bbox.lonMax - bbox.lonMin >= 360 - 1e-6;
}

/** Metres per degree of latitude used for the step-length estimate. */
const METRES_PER_DEGREE = 111195;
/** Steps per baked path: a 16-step half path in each direction. */
const PATH_STEPS = 32;
/** Floor of the box seed budget. */
const MIN_BOX_SEEDS = 100;

/**
 * Seeds to bake for this field. The globe takes baseBudget x globeSeedScale.
 * A boxed field with a spec coverage holds a constant summed path length per
 * degree of box width: seeds = coverage x lonSpan / pathDeg / validRatio,
 * where pathDeg is the median path length (32 steps of the smaller of the
 * step cap and the median step, which (E1) fixes at targetMedianMs x 1800 s)
 * and validRatio corrects for seeds dropped on no-data cells. Clamped to
 * [MIN_BOX_SEEDS, baseBudget].
 */
export function fieldSeedBudget(spec, field, baseBudget) {
  if (isGlobeField(field)) {
    const scale =
      Number.isFinite(spec.globeSeedScale) && spec.globeSeedScale > 0
        ? spec.globeSeedScale
        : 1;
    return Math.round(baseBudget * scale);
  }
  const coverage = spec.boxLineCoverage;
  if (!Number.isFinite(coverage) || coverage <= 0) return baseBudget;
  const bbox = field.bbox;
  const lonSpan = (((bbox.lonMax - bbox.lonMin) % 360) + 360) % 360 || 360;
  const medianStepDeg = (spec.targetMedianMs * 1800) / METRES_PER_DEGREE;
  const pathDeg = PATH_STEPS * Math.min(fieldStepCap(field), medianStepDeg);
  const valid = field.speed?.validCells;
  const total = field.speed?.totalCells;
  const validRatio =
    Number.isFinite(valid) && Number.isFinite(total) && total > 0 && valid > 0
      ? valid / total
      : 1;
  const seeds = Math.round((coverage * lonSpan) / pathDeg / validRatio);
  return Math.max(MIN_BOX_SEEDS, Math.min(baseBudget, seeds));
}

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
