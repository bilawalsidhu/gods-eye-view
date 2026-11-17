import {
  WIND_DISPLAY_HEIGHT_METERS,
  WIND_NARROW_PATH_LIMIT,
  WIND_PATH_LIMIT,
  WIND_PATH_STEPS,
} from './streamlines.js';
import {
  canvasOf,
  findCamera,
  findDraw,
  findFrame,
  rendererOf,
} from '../../render/rendererOf.js';

const WIND_FADE_LOW_METERS = 15000;
const WIND_FADE_HIGH_METERS = 60000;
// The streamlines' colour: the ghost and the trail; the moving tip brightens it.
const WIND_STREAMLINE_COLOR = '#80c9e6';
const WIND_STREAMLINE_WIDTH_PX = 2.4;

let fieldIds = 0;

/** The streamline fade for a camera this high: none low down, full from 60 km. */
export function windHeightFade(height) {
  return Math.max(
    0,
    Math.min(
      1,
      (height - WIND_FADE_LOW_METERS) /
        (WIND_FADE_HIGH_METERS - WIND_FADE_LOW_METERS),
    ),
  );
}

/**
 * A wind grid as the draw port's `windStreamlines` field: samples are
 * points, the first column at `lo1` and the first row at `la1`, rows
 * running south; a grid that wraps the globe spans 360° of longitude.
 */
export function windStreamlineSpec(field, { id, pathBudget, alpha, paused }) {
  const span = field.nx * field.dx;
  const wraps = span >= 360 - 1e-9;
  const west = field.lo1;
  const north = field.la1;
  return {
    kind: 'windStreamlines',
    id,
    u: field.u,
    v: field.v,
    width: field.nx,
    height: field.ny,
    rectangle: {
      west,
      south: north - (field.ny - 1) * field.dy,
      east: west + (wraps ? span : (field.nx - 1) * field.dx),
      north,
    },
    pathBudget,
    steps: WIND_PATH_STEPS,
    style: { color: WIND_STREAMLINE_COLOR, widthPx: WIND_STREAMLINE_WIDTH_PX },
    heightM: WIND_DISPLAY_HEIGHT_METERS,
    alpha,
    paused,
  };
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
} = {}) {
  let handle = null;
  let paused = false;
  let destroyed = false;
  let heightFade = 0;
  let drawn = false;
  const emptyDiagnostics = () => ({
    pathCount: 0,
    buildMs: 0,
    error: null,
    heightFade: 0,
  });
  let diagnostics = emptyDiagnostics();
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
    return Number.isFinite(height) ? windHeightFade(height) : heightFade;
  }

  function setField(field) {
    clear();
    if (!supported() || !field) return false;
    const started = globalThis.performance?.now?.() ?? Date.now();
    const width = canvasOf(viewer())?.clientWidth;
    const pathBudget =
      width > 0 && width < 700 ? WIND_NARROW_PATH_LIMIT : WIND_PATH_LIMIT;
    heightFade = readFade();
    try {
      handle = drawOf(viewer()).field(
        windStreamlineSpec(field, {
          id: `wind-streamlines:${(fieldIds += 1)}`,
          pathBudget,
          alpha: heightFade,
          paused,
        }),
      );
    } catch (error) {
      handle = null;
      diagnostics.error =
        // i18n-ignore: GPU diagnostics only; the panel never shows this field
        error instanceof Error ? error.message : 'Wind geometry unavailable';
      return false;
    }
    handle.on('drawn', () => {
      drawn = true;
      // One more frame, so a still scene shows the layer ready.
      frameOf(viewer())?.requestRender?.('wind');
    });
    diagnostics = {
      ...emptyDiagnostics(),
      pathCount: pathBudget,
      buildMs: (globalThis.performance?.now?.() ?? Date.now()) - started,
      heightFade,
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
      displayHeightMeters: WIND_DISPLAY_HEIGHT_METERS,
    }),
  };
}
