import {
  bakeWindStreamlines,
  WIND_NARROW_PATH_LIMIT,
  WIND_PATH_LIMIT,
} from '../streamlines.js';
import { createFieldRaster } from '../fields.js';
import { fieldUnavailableText, sameWind } from '../rendering.js';
import { createWeatherSurface } from '../../weather/render/navaraSurface.js';
import { WEATHER_SHELL_HEIGHTS } from '../../weather/shellRendering.js';
import { createWindFlowMesh } from './flowMesh.js';

const world = {
  west: -Math.PI,
  south: -Math.PI / 2,
  east: Math.PI,
  north: Math.PI / 2,
};
const clamp = (n) => Math.max(0, Math.min(1, n));
export function createWindNavaraRenderer(engine, native) {
  const canvas = engine.host.canvas,
    media = matchMedia('(prefers-reduced-motion: reduce)');
  let snapshot,
    field,
    mesh,
    surface,
    removeFrame,
    lastAlpha,
    lastTime,
    seconds = 0,
    paths = 0,
    fade = 0;
  let running = false,
    paused = false,
    overlay = 'none',
    error = null,
    budget = 0;
  const wake = () => engine.render.request('wind');
  const build = () => {
    mesh?.destroy();
    mesh = null;
    budget =
      canvas.clientWidth < 700 ? WIND_NARROW_PATH_LIMIT : WIND_PATH_LIMIT;
    const baked = bakeWindStreamlines(field, { count: budget });
    paths = baked.length;
    if (paths) mesh = createWindFlowMesh(native, baked);
  };
  const paint = () => {
    surface?.destroy();
    surface = null;
    lastAlpha = null;
    error = null;
    if (!snapshot || overlay === 'none') return;
    const raster = createFieldRaster(snapshot, overlay);
    if (!raster) {
      error = fieldUnavailableText(overlay);
      return;
    }
    const texture = document.createElement('canvas');
    texture.width = raster.width;
    texture.height = raster.height;
    texture
      .getContext('2d')
      .putImageData(
        new ImageData(raster.rgba, raster.width, raster.height),
        0,
        0,
      );
    surface = createWeatherSurface(engine, native, 'wind', {
      rectangle: world,
      height: WEATHER_SHELL_HEIGHTS.wind,
      onSettled: wake,
    });
    surface.setImage(texture);
    wake();
  };
  const frame = () => {
    if (!running || document.hidden) {
      lastTime = null;
      return;
    }
    const h = engine.camera.pose().cartographic.height;
    if (
      field &&
      budget !==
        (canvas.clientWidth < 700 ? WIND_NARROW_PATH_LIMIT : WIND_PATH_LIMIT)
    )
      build();
    fade = clamp((h - 15000) / 45000);
    const still = paused || media.matches;
    const now = performance.now();
    if (!still && fade && lastTime != null)
      seconds += Math.min(0.1, (now - lastTime) / 1000);
    lastTime = !still && fade ? now : null;
    mesh?.update({
      time: seconds % 10000,
      fade,
      still,
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    });
    if (surface) {
      let alpha =
        (overlay === 'temperature' ? 1 : 0.85) *
        clamp(Math.log(Math.max(1, h) / 200000) / Math.log(6));
      if (engine.maps.photorealActive()) alpha = Math.round(alpha * 10) / 10;
      if (
        lastAlpha == null ||
        Math.abs(alpha - lastAlpha) > 0.005 ||
        (alpha === 0 && lastAlpha !== 0)
      ) {
        lastAlpha = alpha;
        surface.setAlpha(alpha);
        surface.setShow(alpha > 0);
      }
    }
    if (mesh && !still && fade) wake();
  };
  const reset = () => {
    mesh?.destroy();
    mesh = null;
    surface?.destroy();
    surface = null;
    field = snapshot = null;
    paths = 0;
    error = null;
    lastAlpha = lastTime = null;
  };
  const preferenceChanged = () => {
    lastTime = null;
    wake();
  };
  return {
    attach() {
      removeFrame = engine.frames.preRender.addEventListener(frame);
      media.addEventListener('change', preferenceChanged);
      document.addEventListener('visibilitychange', preferenceChanged);
    },
    setField(next) {
      const nextField = { ...next.grid, u: next.u, v: next.v };
      const changed = !sameWind(snapshot, next, field, nextField);
      snapshot = next;
      field = nextField;
      if (changed) build();
      paint();
      wake();
    },
    setOptions(next) {
      paused = next.paused;
      if (overlay !== next.overlay) {
        overlay = next.overlay;
        paint();
      }
      wake();
    },
    start() {
      running = true;
      wake();
    },
    stop() {
      running = false;
      lastTime = null;
    },
    clear: reset,
    destroy() {
      running = false;
      removeFrame?.();
      media.removeEventListener('change', preferenceChanged);
      document.removeEventListener('visibilitychange', preferenceChanged);
      reset();
    },
    getParticleCount: () => paths,
    getDiagnostics: () => ({
      renderMode: 'gpu-streamlines',
      reducedMotion: media.matches,
      imageryError: error,
      gpu: {
        pathCount: paths,
        phaseSeconds: seconds,
        ready: Boolean(mesh),
        heightFade: fade,
        vertexCount: (mesh?.segments ?? 0) * 4,
      },
      surface: surface?.getDiagnostics() ?? null,
    }),
  };
}
