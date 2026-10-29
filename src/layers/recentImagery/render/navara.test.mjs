import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecentImageryNavaraRenderer } from './navara.js';

test('slot replacement, alpha-only edits, and destruction own textures, credits and late decodes', async () => {
  const previousDocument = globalThis.document,
    canvases = [],
    jobs = [],
    draws = [];
  globalThis.document = {
    createElement() {
      const c = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: (i) => draws.push(i) }),
      };
      canvases.push(c);
      return c;
    },
  };
  let owner,
    removed = 0,
    credits = 0,
    textureDisposals = 0,
    off = 0;
  const callbacks = [];
  const engine = {
    camera: {
      changed: {
        addEventListener(fn) {
          callbacks.push(fn);
          return () => off++;
        },
      },
      pose: () => ({
        cartographic: { height: 12000, latitude: 0.5 },
        fovy: 0.7,
      }),
      viewRectangle: () => null,
    },
    host: {
      canvas: { width: 1280 },
      size: () => ({ width: 1280, height: 800 }),
    },
    maps: { current: () => ({ photoreal: null }) },
    render: { request() {} },
    credits: {
      addStatic() {
        credits++;
        return () => credits--;
      },
    },
  };
  const view = {
    registerEffect() {},
    addEffect(config) {
      owner = config.gevRecentImagery.owner;
      return {
        update() {},
        delete() {
          removed++;
        },
      };
    },
  };
  const renderer = createRecentImageryNavaraRenderer(engine, {
    view,
    EffectDesc: class {},
    NavaraEffect: class {},
    load: (url, signal) =>
      new Promise((resolve) => jobs.push({ url, signal, resolve })),
  });
  try {
    const box = { west: -97.77, east: -97.71, south: 30.25, north: 30.29 };
    const candidate = {
      key: 'S30:2026-10-28',
      product: 'S30',
      day: '2026-10-28',
    };
    renderer.rebind(renderer.resolveHost());
    renderer.showSlot('a', candidate, box);
    await new Promise((resolve) => setImmediate(resolve));
    const texture = owner.slots.a.atlas.texture,
      canvas = owner.slots.a.atlas.canvas;
    texture.addEventListener('dispose', () => textureDisposals++);
    const originalJobs = jobs.length;
    renderer.showSlot('a', candidate, box, {
      alpha: 0.4,
      splitDirection: 'left',
    });
    renderer.setSplit(0.3);
    callbacks[0]();
    assert.equal(owner.slots.a.atlas.texture, texture);
    assert.equal(jobs.length, originalJobs);
    assert.equal(owner.split, 0.3);
    assert.equal(renderer.getOwned().a.alpha, 0.4);
    assert.equal(credits, 1);
    renderer.showSlot(
      'a',
      { ...candidate, key: 'new', day: '2026-10-27' },
      box,
    );
    assert.equal(textureDisposals, 1);
    assert.equal(canvas.width, 0);
    assert.ok(jobs.every((j) => j.signal.aborted));
    let closed = 0;
    for (const j of jobs) j.resolve({ close: () => closed++ });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(draws.length, 0);
    assert.equal(closed, originalJobs);
    renderer.destroy();
    renderer.destroy();
    for (const j of jobs.slice(originalJobs))
      j.resolve({ close: () => closed++ });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(renderer.ownedCount(), 0);
    assert.equal(credits, 0);
    assert.equal(removed, 1);
    assert.equal(off, 1);
    assert.equal(renderer.diagnostics().active, 0);
    assert.ok(canvases.every((c) => c.width === 0));
  } finally {
    renderer.destroy();
    globalThis.document = previousDocument;
  }
});
