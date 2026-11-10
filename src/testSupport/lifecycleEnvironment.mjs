import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

export function installLifecycleEnvironment(t) {
  const window = new Window({ url: 'http://localhost/' });
  const network = [];
  for (const name of [
    'window',
    'document',
    'localStorage',
    'CustomEvent',
    'ResizeObserver',
    'Image',
    'Audio',
    'createImageBitmap',
  ]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === 'window' ? window : window[name],
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  t.mock.timers.enable({
    apis: ['Date', 'setTimeout', 'setInterval'],
    now: Date.UTC(2026, 0, 1),
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    network.push(String(url));
    const body = String(url).endsWith('/event.json')
      ? await readFile(
          new URL(
            '../../public/events/bhote-koshi-2026/event.json',
            import.meta.url,
          ),
          'utf8',
        )
      : JSON.stringify({ type: 'FeatureCollection', features: [] });
    return new Response(body, {
      headers: { 'content-type': 'application/json' },
    });
  });
  globalThis.Image = class {
    width = 1;
    height = 1;
    set src(value) {
      queueMicrotask(() => this.onload?.());
    }
  };
  globalThis.createImageBitmap = async () => ({
    width: 1,
    height: 1,
    close() {},
  });
  for (const name of [
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
  ])
    window[name] = globalThis[name];
  const raf = globalThis.requestAnimationFrame;
  const caf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) =>
    setTimeout(() => callback(Date.now()), 16);
  globalThis.cancelAnimationFrame = clearTimeout;
  t.after(() => {
    if (raf) globalThis.requestAnimationFrame = raf;
    else delete globalThis.requestAnimationFrame;
    if (caf) globalThis.cancelAnimationFrame = caf;
    else delete globalThis.cancelAnimationFrame;
    window.happyDOM.abort();
  });
  const context = {
    measureText: (text) => ({ width: String(text).length * 8 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  for (const name of [
    'clearRect',
    'fillRect',
    'strokeRect',
    'beginPath',
    'closePath',
    'moveTo',
    'lineTo',
    'arc',
    'ellipse',
    'fill',
    'stroke',
    'save',
    'restore',
    'translate',
    'rotate',
    'scale',
    'setTransform',
    'drawImage',
    'fillText',
    'strokeText',
    'roundRect',
    'quadraticCurveTo',
    'bezierCurveTo',
    'clip',
    'setLineDash',
  ])
    context[name] = () => {};
  t.mock.method(
    window.HTMLCanvasElement.prototype,
    'getContext',
    () => context,
  );
  return { window, network };
}

export async function flushLifecycleTasks(t, ms = 0) {
  // Drain promise chains before running timers, including atlas preparation.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  t.mock.timers.tick(ms);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
