// The wind on the globe contract: its colour field (speed, temperature or
// pressure) is one engine.imagery image over the globe, draped where
// imagery drapes on the globe and raised at the wind's shell height on 3D
// tiles, faded out as the camera comes down while streamlines draw (they
// carry the wind near the ground). The streamlines are the engine's own,
// behind one seam: the `flow` backend the application passes in for each
// engine (Cesium's wind renderer, rendering.js, on the page's SDK;
// Navara's flow mesh, src/globe/navara/windFlow.js). Without one the field draws
// alone.

import { createFieldRaster, fieldUnavailableText } from '../fields.js';
import { NO_IMAGERY_HOST } from '../../shared/imageryHost.js';
import { WEATHER_SHELL_HEIGHTS } from '../../weather/shellRendering.js';
import { WEATHER_IMAGERY_ORDER } from '../../weather/render/display.js';

const FADE_LOW_METERS = 200_000;
const FADE_HIGH_METERS = 1_200_000;
const FADE_LOG_RANGE = Math.log(FADE_HIGH_METERS / FADE_LOW_METERS);
const OVERLAYS = ['none', 'speed', 'temperature', 'pressure'];
let fields = 0;

/** The field's alpha for a camera `height` m up: none below 200 km, full
 * above 1200 km, logarithmic between, while streamlines draw. */
export function windFieldAlpha(overlay, height, flowing) {
  const base = overlay === 'temperature' ? 1 : 0.85;
  if (!flowing) return base;
  const fade = Math.max(
    0,
    Math.min(
      1,
      Math.log(Math.max(1, height) / FADE_LOW_METERS) / FADE_LOG_RANGE,
    ),
  );
  return base * fade;
}

function rasterCanvas(raster) {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(raster.width, raster.height);
  pixels.data.set(raster.rgba);
  context.putImageData(pixels, 0, 0);
  return canvas;
}

/**
 * The wind layer's renderer on any engine (index.js).
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ flow?: (engine: object, options: object) => object,
 *   onStatusChange?: () => void,
 *   createCanvas?: (raster: object) => object }} [options]
 *   `flow(engine, { onStatusChange })` makes the engine's streamlines
 *   (rendering.js's interface: attach, setField, setOptions, start, stop,
 *   clear, destroy, getParticleCount, getDiagnostics).
 */
export function createWindDisplay(
  engine,
  {
    flow: makeFlow = null,
    onStatusChange = () => {},
    createCanvas = rasterCanvas,
  } = {},
) {
  const flow = makeFlow?.(engine, { onStatusChange }) ?? null;
  const id = `wind-field-${++fields}`;
  let snapshot = null;
  let overlay = 'none';
  let paused = false;
  let layer = null;
  let layerSurface = null;
  let imageryError = null;
  let lastAlpha = null;
  let removeFrame = null;

  const flowing = () =>
    flow?.getDiagnostics?.().renderMode === 'gpu-streamlines';
  function removeField() {
    layer?.destroy();
    layer = null;
    layerSurface = null;
    lastAlpha = null;
  }
  function fade() {
    if (!layer) return;
    let height;
    try {
      height = engine.camera.pose().cartographic.height;
    } catch {
      return;
    }
    let alpha = windFieldAlpha(overlay, height, flowing());
    // On 3D tiles the shell keeps a coarse fade: fewer restyles.
    if (layer.raise() !== null) alpha = Math.round(alpha * 10) / 10;
    if (
      lastAlpha !== null &&
      Math.abs(alpha - lastAlpha) <= 0.005 &&
      !(alpha === 0 && lastAlpha !== 0)
    )
      return;
    lastAlpha = alpha;
    layer.setAlpha(alpha);
    layer.show(alpha > 0);
  }
  function installField() {
    removeField();
    const previous = imageryError;
    imageryError = null;
    if (snapshot && overlay !== 'none') {
      const surface = engine.imagery.surface();
      layerSurface = surface;
      if (surface === 'none') imageryError = NO_IMAGERY_HOST;
      else {
        const raster = createFieldRaster(snapshot, overlay);
        if (!raster) imageryError = fieldUnavailableText(overlay);
        else {
          layer = engine.imagery.createLayer({
            id,
            order: WEATHER_IMAGERY_ORDER.wind,
            alpha: 0,
            show: false,
            source: { kind: 'image', image: createCanvas(raster) },
            ...(surface === 'tiles'
              ? { raise: WEATHER_SHELL_HEIGHTS.wind }
              : {}),
          });
          layerSurface = surface;
          fade();
        }
      }
    }
    if (previous !== imageryError) onStatusChange();
  }
  // Every frame: the fade, and the field again on another surface.
  function frame() {
    if (
      snapshot &&
      overlay !== 'none' &&
      engine.imagery.surface() !== layerSurface
    )
      installField();
    else fade();
  }

  return {
    rehome() {
      flow?.rehome?.();
      if (snapshot && engine.imagery.surface() !== layerSurface) installField();
    },
    attach() {
      flow?.attach();
      removeFrame ??= engine.frames.preRender.addEventListener(frame);
    },
    setField(next) {
      snapshot = next;
      flow?.setField(next);
      installField();
      engine.render.request('wind');
    },
    setOptions(next = {}) {
      paused = typeof next.paused === 'boolean' ? next.paused : paused;
      const nextOverlay = OVERLAYS.includes(next.overlay)
        ? next.overlay
        : overlay;
      flow?.setOptions({ overlay: nextOverlay, paused });
      if (nextOverlay !== overlay) {
        overlay = nextOverlay;
        installField();
      }
      engine.render.request('wind');
    },
    start() {
      flow?.start();
      engine.render.request('wind');
    },
    stop() {
      flow?.stop();
    },
    clear() {
      flow?.clear();
      snapshot = null;
      removeField();
      imageryError = null;
    },
    destroy() {
      flow?.stop();
      flow?.destroy();
      removeFrame?.();
      removeFrame = null;
      snapshot = null;
      removeField();
    },
    getParticleCount: () => flow?.getParticleCount() ?? 0,
    getDiagnostics() {
      const drawn = flow?.getDiagnostics?.() ?? {};
      return {
        ...drawn,
        overlay,
        paused,
        imageryActive: layer !== null,
        host: layer ? (layer.raise() !== null ? 'shell' : 'globe') : null,
        field: layer
          ? {
              alpha: layer.alpha(),
              shown: layer.shown(),
              raise: layer.raise(),
              ready: layer.ready(),
            }
          : null,
        imageryError,
      };
    },
  };
}
