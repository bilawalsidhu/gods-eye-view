import { createWeatherShell } from '../shellRendering.js';
import { escapeCreditText, weatherDisplay } from '../display.js';
import { createWeatherSurface } from './navaraSurface.js';

/** Use the same decoded frames, detail windows, infrared mask and prefetch policy as the weather shell. */
export function createWeatherNavaraRenderer(engine, native, options) {
  let shell = null,
    alpha = 0.7,
    hidden = false,
    removeCredit = null,
    credit = null;
  const updateSnapshot = (snapshot) => {
    const next = weatherDisplay(snapshot).credit ?? null;
    if (next === credit) return;
    removeCredit?.();
    credit = next;
    removeCredit = next
      ? engine.credits.addStatic(escapeCreditText(next))
      : null;
  };
  const select = (product) => {
    if (shell?.product === product) return shell;
    shell?.clear();
    shell = createWeatherShell({
      ...options,
      product,
      requestRender: () => engine.render.request('weather'),
      viewRectangle: () => engine.camera.viewRectangle(),
      moveEnd: engine.camera.moveEnd,
      createSurface: (frame) =>
        createWeatherSurface(engine, native, product, frame),
    });
    shell.setAlpha(alpha);
    shell.setHidden(hidden);
    return shell;
  };
  return {
    setFrame(snapshot, time, params) {
      updateSnapshot(snapshot);
      return select(snapshot.product).setFrame(snapshot, time, params);
    },
    updateSnapshot,
    prefetch: (...args) => shell?.prefetch(...args),
    cancelPrefetch: () => shell?.cancelPrefetch(),
    rehome: () => shell?.rehome(),
    setHidden(value) {
      hidden = value;
      shell?.setHidden(value);
    },
    setAlpha(value) {
      alpha = value;
      shell?.setAlpha(value);
    },
    getDiagnostics: () =>
      shell?.getDiagnostics() ?? { time: null, loading: false },
    clear() {
      shell?.clear();
      shell = null;
      removeCredit?.();
      removeCredit = credit = null;
    },
  };
}
