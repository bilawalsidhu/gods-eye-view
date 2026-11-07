import {
  bakeWindStreamlines,
  WIND_DISPLAY_HEIGHT_METERS,
  WIND_NARROW_PATH_LIMIT,
  WIND_PATH_LIMIT,
} from '../../layers/wind/streamlines.js';
import { sameWind } from '../../layers/wind/model.js';

const clamp = (n) => Math.max(0, Math.min(1, n));

/**
 * The wind's streamlines on Navara (the display's flow backend,
 * render/display.js): baked paths as one flow mesh in Navara's view, faded
 * in with the camera's height and moved by the page clock while the scene
 * is shown and motion is allowed. The colour field is the display's.
 */
export function createWindNavaraFlow(engine, native, createWindFlowMesh) {
  const canvas = engine.host.canvas,
    media = matchMedia('(prefers-reduced-motion: reduce)');
  let snapshot = null,
    field = null,
    mesh = null,
    removeFrame = null,
    lastTime = null,
    seconds = 0,
    paths = 0,
    fade = 0,
    budget = 0;
  let running = false,
    paused = false;
  const wake = () => engine.render.request('wind');
  const limit = () =>
    canvas.clientWidth < 700 ? WIND_NARROW_PATH_LIMIT : WIND_PATH_LIMIT;
  const build = () => {
    mesh?.destroy();
    mesh = null;
    budget = limit();
    const baked = bakeWindStreamlines(field, { count: budget });
    paths = baked.length;
    if (paths)
      mesh = createWindFlowMesh(native, baked, WIND_DISPLAY_HEIGHT_METERS);
  };
  const frame = () => {
    if (!running || document.hidden) {
      lastTime = null;
      return;
    }
    const h = engine.camera.pose().cartographic.height;
    if (field && budget !== limit()) build();
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
    if (mesh && !still && fade) wake();
  };
  const reset = () => {
    mesh?.destroy();
    mesh = null;
    field = snapshot = null;
    paths = 0;
    lastTime = null;
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
    /** A wind snapshot; its paths are baked again when its vectors changed. */
    setField(next) {
      const nextField = { ...next.grid, u: next.u, v: next.v };
      const changed = !sameWind(snapshot, next, field, nextField);
      snapshot = next;
      field = nextField;
      if (changed || !mesh) build();
      wake();
    },
    setOptions(next) {
      paused = next.paused;
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
      gpu: {
        pathCount: paths,
        phaseSeconds: seconds,
        ready: Boolean(mesh),
        heightFade: fade,
        vertexCount: (mesh?.segments ?? 0) * 4,
      },
    }),
  };
}
