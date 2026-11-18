import {
  WIND_NARROW_PATH_LIMIT,
  WIND_PATH_LIMIT,
  WIND_PATH_STEPS,
  bakeWindStreamlines,
  measureLineCoverage,
} from './streamlines.js';
import {
  WIND_FIELD_SPEC,
  fieldRampMax,
  fieldSeedBudget,
  fieldSpeedScale,
  isGlobeField,
} from './fieldSpec.js';
import {
  canvasOf,
  findCamera,
  findDraw,
  findFrame,
  rendererOf,
} from '../../render/rendererOf.js';

// The streamlines' colour: the ghost and the trail; the moving tip brightens it.
const WIND_STREAMLINE_COLOR = '#80c9e6';
const WIND_STREAMLINE_WIDTH_PX = 2.4;
// The tracer's own step and calm cutoff: a field that keeps them names neither.
const DEFAULT_STEP_SECONDS = 1800;
const DEFAULT_CALM_MS = 0.15;

let fieldIds = 0;

/**
 * The streamline fade for a camera this high: none at or below the spec's
 * `fadeLowMeters`, full from `fadeHighMeters` (wind: 15 km and 60 km).
 */
export function windHeightFade(height, spec = WIND_FIELD_SPEC) {
  return Math.max(
    0,
    Math.min(
      1,
      (height - spec.fadeLowMeters) /
        (spec.fadeHighMeters - spec.fadeLowMeters),
    ),
  );
}

/** The rectangle a grid's samples span; a grid round the globe spans 360°. */
function gridRectangle(field) {
  const span = field.nx * field.dx;
  const wraps = span >= 360 - 1e-9;
  const west = field.lo1;
  const north = field.la1;
  return {
    west,
    south: north - (field.ny - 1) * field.dy,
    east: west + (wraps ? span : (field.nx - 1) * field.dx),
    north,
  };
}

/**
 * A vector grid as the draw port's `windStreamlines` field: samples are
 * points, the first column at `lo1` and the first row at `la1`, rows
 * running south; a grid that wraps the globe spans 360° of longitude.
 * `spec` (a field spec, wind's by default) gives the draw height, the calm
 * cutoff and the speed ramp; a ramp of one colour is not sent, and neither
 * are a step or a cutoff equal to the tracer's own, so the wind's field is
 * what it was before fields had specs.
 */
export function windStreamlineSpec(
  field,
  { id, pathBudget, alpha, paused, spec = WIND_FIELD_SPEC },
) {
  const stepSeconds = DEFAULT_STEP_SECONDS * fieldSpeedScale(spec, field);
  const tinted = spec.ramp.some((stop) => stop !== spec.ramp[0]);
  return {
    kind: 'windStreamlines',
    id,
    u: field.u,
    v: field.v,
    width: field.nx,
    height: field.ny,
    rectangle: gridRectangle(field),
    pathBudget,
    steps: WIND_PATH_STEPS,
    style: {
      color: WIND_STREAMLINE_COLOR,
      widthPx: WIND_STREAMLINE_WIDTH_PX,
      ...(tinted
        ? {
            ramp: {
              stops: [...spec.ramp],
              maxMs: fieldRampMax(spec, field),
              gamma: spec.rampGamma,
            },
          }
        : {}),
    },
    ...(Number.isFinite(field.noData) ? { noData: field.noData } : {}),
    ...(stepSeconds !== DEFAULT_STEP_SECONDS ? { stepSeconds } : {}),
    ...(spec.calmCutoffMs !== DEFAULT_CALM_MS
      ? { calmMs: spec.calmCutoffMs }
      : {}),
    heightM: spec.displayHeightMeters,
    alpha,
    paused,
  };
}

/**
 * Seeds to ask the renderer for. The globe takes the spec's share of the
 * base budget. A boxed field with a spec coverage starts from the estimate
 * (`fieldSeedBudget`), which assumes median-length paths; coasts and no-data
 * cut them short, so the paths are traced once here, as the renderer will
 * trace them, and the seed count is rescaled by the measured shortfall,
 * still bounded by the base budget.
 * @returns {{seeds: number, lineCoverage: number | null}}
 */
export function streamlineSeeds(field, spec, baseBudget) {
  let seeds = fieldSeedBudget(spec, field, baseBudget);
  const target = spec.boxLineCoverage;
  if (isGlobeField(field) || !Number.isFinite(target) || target <= 0)
    return { seeds, lineCoverage: null };
  const bounds = gridRectangle(field);
  const span = bounds.east - bounds.west;
  const grid = { ...field, periodic: false };
  const coverageAt = (count) =>
    measureLineCoverage(
      bakeWindStreamlines(grid, {
        count,
        maxCount: count,
        stepSeconds: DEFAULT_STEP_SECONDS * fieldSpeedScale(spec, field),
        calmCutoffMs: spec.calmCutoffMs,
        bounds,
      }),
      span,
    );
  let lineCoverage = coverageAt(seeds);
  if (lineCoverage > 0 && lineCoverage < 0.9 * target) {
    const corrected = Math.min(
      baseBudget,
      Math.round((seeds * target) / lineCoverage),
    );
    if (corrected > seeds) {
      seeds = corrected;
      lineCoverage = coverageAt(seeds);
    }
  }
  return { seeds, lineCoverage };
}

/**
 * Streamlines through the draw port's `windStreamlines` field (capability
 * `fields`): the renderer traces, draws, culls and animates them; this
 * fades them by camera height and pauses them. Where the renderer has no
 * such field, or refuses this one, `setField` answers false and the layer
 * paints on its canvas instead. No animation loop or DOM ownership.
 */
export function createWindGpuRendering({
  getViewer,
  drawOf = findDraw,
  cameraOf = findCamera,
  frameOf = findFrame,
  spec = WIND_FIELD_SPEC,
} = {}) {
  let handle = null;
  let paused = false;
  let destroyed = false;
  let heightFade = 0;
  let drawn = false;
  const emptyDiagnostics = () => ({
    pathCount: 0,
    buildMs: 0,
    readyMs: null,
    error: null,
    heightFade: 0,
    speedScale: 1,
    stepSeconds: DEFAULT_STEP_SECONDS,
  });
  let diagnostics = emptyDiagnostics();
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const viewer = () => getViewer?.() ?? null;

  function supported() {
    const host = viewer();
    if (destroyed || !host) return false;
    const capabilities = rendererOf(host)?.capabilities;
    if (capabilities && !capabilities.has('fields')) return false;
    return typeof drawOf(host)?.field === 'function';
  }

  function clear() {
    handle?.dispose();
    handle = null;
    drawn = false;
    diagnostics = emptyDiagnostics();
  }

  function readFade() {
    const height = cameraOf(viewer())?.pose?.().height;
    return Number.isFinite(height) ? windHeightFade(height, spec) : heightFade;
  }

  function setField(field) {
    clear();
    if (!supported() || !field) return false;
    const started = now();
    const width = canvasOf(viewer())?.clientWidth;
    const baseBudget =
      width > 0 && width < 700 ? WIND_NARROW_PATH_LIMIT : WIND_PATH_LIMIT;
    heightFade = readFade();
    let seeds;
    let lineCoverage;
    try {
      ({ seeds, lineCoverage } = streamlineSeeds(field, spec, baseBudget));
      handle = drawOf(viewer()).field(
        windStreamlineSpec(field, {
          id: `wind-streamlines:${(fieldIds += 1)}`,
          pathBudget: seeds,
          alpha: heightFade,
          paused,
          spec,
        }),
      );
    } catch (error) {
      handle = null;
      diagnostics.error =
        // i18n-ignore: GPU diagnostics only; the panel never shows this field
        error instanceof Error ? error.message : 'Wind geometry unavailable';
      return false;
    }
    const built = handle;
    handle.on('drawn', () => {
      if (handle !== built) return;
      drawn = true;
      // Geometry is built on workers after the field is made, so "ready"
      // lands frames after setField returns; readyMs shares buildMs's origin.
      if (diagnostics.readyMs === null) diagnostics.readyMs = now() - started;
      // One more frame, so a still scene shows the layer ready.
      frameOf(viewer())?.requestRender?.('wind');
    });
    const speedScale = fieldSpeedScale(spec, field);
    diagnostics = {
      ...emptyDiagnostics(),
      pathCount: seeds,
      seedCount: seeds,
      lineCoverage,
      buildMs: now() - started,
      heightFade,
      speedScale,
      stepSeconds: DEFAULT_STEP_SECONDS * speedScale,
    };
    return true;
  }

  /** Fade by camera height; whether anything can draw. */
  function updateVisibility() {
    const fade = readFade();
    diagnostics.heightFade = fade;
    if (handle && fade !== heightFade) handle.update({ alpha: fade });
    heightFade = fade;
    return Boolean(handle) && fade > 0;
  }

  return {
    supported,
    setField,
    updateVisibility,
    setOptions(options = {}) {
      if (typeof options.paused !== 'boolean' || options.paused === paused)
        return;
      paused = options.paused;
      handle?.update({ paused });
    },
    clear,
    destroy() {
      clear();
      destroyed = true;
    },
    getParticleCount: () => diagnostics.pathCount,
    getDiagnostics: () => ({
      ...diagnostics,
      ready: Boolean(handle) && drawn,
      mode: 'gpu-streamlines',
      displayHeightMeters: spec.displayHeightMeters,
    }),
  };
}
