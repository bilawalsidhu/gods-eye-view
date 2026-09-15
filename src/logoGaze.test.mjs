import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateLogoGaze, initLogoGaze } from './logoGaze.js';

const rect = { left: 100, top: 50, width: 80, height: 40 };

test('logo gaze is neutral when the cursor is centered', () => {
  assert.deepEqual(calculateLogoGaze(140, 70, rect), { x: 0, y: 0 });
});

test('logo gaze follows direction and caps at the requested offset', () => {
  const gaze = calculateLogoGaze(1140, 70, rect, 28);
  assert.ok(Math.abs(gaze.x - 28) < 1e-9);
  assert.equal(gaze.y, 0);
});

test('logo gaze uses the more visible default travel', () => {
  const gaze = calculateLogoGaze(1140, 70, rect);
  assert.ok(Math.abs(gaze.x - 34) < 1e-9);
  assert.equal(gaze.y, 0);
});

test('logo gaze ramps proportionally inside the full-gaze distance', () => {
  const gaze = calculateLogoGaze(300, 70, rect, 28);
  assert.ok(Math.abs(gaze.x - 14) < 1e-9);
  assert.equal(gaze.y, 0);
});

test('logo gaze preserves diagonal direction while staying bounded', () => {
  const gaze = calculateLogoGaze(640, 570, rect, 28);
  assert.ok(Math.abs(Math.hypot(gaze.x, gaze.y) - 28) < 1e-9);
  assert.ok(gaze.x > 0);
  assert.ok(gaze.y > 0);
});

test('logo gaze fails closed for invalid geometry', () => {
  assert.deepEqual(calculateLogoGaze(10, 10, { ...rect, width: 0 }), { x: 0, y: 0 });
  assert.deepEqual(calculateLogoGaze(Number.NaN, 10, rect), { x: 0, y: 0 });
});

/**
 * Browser surface for initLogoGaze: window events + rAF capture, one fake
 * logo element, and a DOMParser serving canned SVG markup. Restores all
 * globals on restore().
 */
function stubLogoGazeDom({ reducedMotion = false, markup = '<svg><g id="globe"/><g id="globe_cage"/></svg>', fetchOk = true, parseThrows = false } = {}) {
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    DOMParser: globalThis.DOMParser,
  };
  const listeners = { window: new Map(), documentElement: new Map() };
  const rafQueue = [];
  const calls = { fetch: 0, replaceChildren: 0, cancelled: 0 };
  const parts = new Map([['#globe', makePart()], ['#globe_cage', makePart()]]);

  function makePart() {
    return {
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
    };
  }

  function makeSvgElement() {
    return {
      attrs: {},
      children: [],
      removed: 0,
      cloneNode() { return makeSvgElement(); },
      removeAttribute() {},
      setAttribute(k, v) { this.attrs[k] = v; },
      querySelector(sel) {
        if (sel === 'title') return null;
        return parts.get(sel) ?? null;
      },
    };
  }

  const logo = {
    dataset: {},
    rect: { left: 100, top: 50, width: 80, height: 40 },
    child: null,
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getBoundingClientRect() { return this.rect; },
    replaceChildren(el) { calls.replaceChildren += 1; this.child = el; },
  };

  globalThis.window = {
    fetch: async () => { calls.fetch += 1; return { ok: fetchOk, text: async () => markup }; },
    matchMedia: () => ({ matches: reducedMotion }),
    addEventListener(type, fn) { listeners.window.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.window.get(type) === fn) listeners.window.delete(type); },
    requestAnimationFrame(cb) { rafQueue.push(cb); return rafQueue.length; },
    cancelAnimationFrame() { calls.cancelled += 1; },
  };
  globalThis.document = {
    documentElement: {
      addEventListener(type, fn) { listeners.documentElement.set(type, fn); },
      removeEventListener(type, fn) { if (listeners.documentElement.get(type) === fn) listeners.documentElement.delete(type); },
    },
    querySelectorAll: (sel) => (sel === '[data-logo-gaze]' ? [logo] : []),
  };
  globalThis.DOMParser = class {
    parseFromString(str) {
      if (parseThrows) throw new Error('malformed markup');
      return {
        documentElement: makeSvgElement(),
        querySelector: (sel) => (sel === 'parsererror' && str.includes('parsererror-marker') ? {} : null),
      };
    }
  };

  const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const runFrames = (max = 400) => {
    let n = 0;
    while (rafQueue.length && n < max) {
      const cb = rafQueue.shift();
      cb();
      n += 1;
    }
    return n;
  };

  return {
    logo, parts, listeners, rafQueue, calls, tick, runFrames,
    restore() {
      globalThis.window = saved.window;
      globalThis.document = saved.document;
      globalThis.DOMParser = saved.DOMParser;
    },
  };
}

test('initLogoGaze is a safe no-op without a browser or marked logos', () => {
  const savedWindow = globalThis.window;
  globalThis.window = undefined;
  const cleaned = initLogoGaze({ querySelectorAll: () => [] });
  globalThis.window = savedWindow;
  assert.equal(typeof cleaned, 'function');
  assert.doesNotThrow(() => cleaned());
});

test('initLogoGaze loads the inline logo and eases the gaze to the pointer', async () => {
  const dom = stubLogoGazeDom();
  try {
    const cleanup = initLogoGaze(dom.document);
    assert.equal(dom.calls.fetch, 1, 'inline logo fetched once at init');
    await dom.tick();
    assert.equal(dom.calls.replaceChildren, 1, 'fallback img replaced by inline svg');
    assert.ok(dom.logo.child, 'the inline svg node was installed as the logo child');
    assert.equal(dom.parts.get('#globe').attrs.transform, 'translate(0.00 0.00)', 'initial transform applied');

    const onMove = dom.listeners.window.get('pointermove');
    assert.equal(typeof onMove, 'function');
    onMove({ clientX: 440, clientY: 50, pointerType: 'mouse' });
    assert.ok(dom.rafQueue.length >= 1, 'pointer movement schedules the easing loop');
    dom.runFrames();
    const tx = Number(dom.parts.get('#globe').attrs.transform.split('(')[1].split(' ')[0]);
    // 300 px out of the 320 px full-gaze distance → strength 0.9375 → target
    // 34 * 0.9375 = 31.875; the easing loop must settle exactly on it.
    assert.ok(Math.abs(tx - 31.875) < 0.01, `settled on the ramped target (got ${tx})`);

    dom.listeners.window.get('blur')?.();
    dom.runFrames();
    const backX = Number(dom.parts.get('#globe').attrs.transform.split('(')[1].split(' ')[0]);
    assert.equal(backX, 0, 'blur resets the gaze to center');
    // Re-arm mid-animation, then clean up — the pending frame must be cancelled.
    onMove({ clientX: 900, clientY: 50, pointerType: 'mouse' });
    assert.ok(dom.rafQueue.length >= 1, 'a new move re-arms the loop');
    cleanup();
    assert.equal(dom.listeners.window.size, 0, 'cleanup removes window listeners');
    assert.equal(dom.listeners.documentElement.size, 0, 'cleanup removes document listeners');
    assert.ok(dom.calls.cancelled >= 1, 'cleanup cancels the pending frame');
  } finally {
    dom.restore();
  }
});

test('initLogoGaze ignores touch pointers and honors prefers-reduced-motion', async () => {
  const touchDom = stubLogoGazeDom();
  try {
    const cleanupTouch = initLogoGaze(touchDom.document);
    touchDom.listeners.window.get('pointermove')({ clientX: 900, clientY: 50, pointerType: 'touch' });
    assert.equal(touchDom.rafQueue.length, 0, 'touch never starts the loop');
    cleanupTouch();
  } finally {
    touchDom.restore();
  }

  const rmDom = stubLogoGazeDom({ reducedMotion: true });
  try {
    const cleanupRm = initLogoGaze(rmDom.document);
    assert.equal(rmDom.calls.fetch, 0, 'reduced motion skips the inline load');
    rmDom.listeners.window.get('pointermove')({ clientX: 900, clientY: 50, pointerType: 'mouse' });
    assert.equal(rmDom.rafQueue.length, 0, 'reduced motion ignores pointer moves');
    cleanupRm();
  } finally {
    rmDom.restore();
  }
});

test('initLogoGaze keeps the fallback when the inline asset fails or is invalid', async () => {
  const badMarkup = '<svg>parsererror-marker</svg>';
  for (const opts of [{ fetchOk: false }, { markup: badMarkup }, { parseThrows: true }]) {
    const dom = stubLogoGazeDom(opts);
    try {
      const cleanup = initLogoGaze(dom.document);
      await dom.tick();
      assert.equal(dom.calls.replaceChildren, 0, `fallback kept for ${JSON.stringify(opts)}`);
      cleanup();
    } finally {
      dom.restore();
    }
  }
});

test('initLogoGaze cleanup stops an in-flight inline load from touching the DOM', async () => {
  const dom = stubLogoGazeDom();
  try {
    const cleanup = initLogoGaze(dom.document);
    cleanup();
    await dom.tick();
    assert.equal(dom.calls.replaceChildren, 0, 'disposed run never replaces children');
  } finally {
    dom.restore();
  }
});
