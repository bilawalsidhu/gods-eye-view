import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeEngine } from '../../src/globe/testing/fakeEngine.js';
import { measureIdleRender } from './idle.mjs';

function fixture(t) {
  const engine = createFakeEngine();
  const previous = globalThis.window;
  globalThis.window = { __godsEyeView: { engine } };
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
    engine.destroy();
  });
  return {
    engine,
    page: { evaluate: (fn, options) => fn(options) },
    tick(ms) {
      now += ms;
      t.mock.timers.tick(ms);
    },
  };
}

test('idle measurement waits out fades, records reasons, and never requests a frame', async (t) => {
  const { engine, page, tick } = fixture(t);
  const original = engine.render.request;
  const pending = measureIdleRender(page, { quietMs: 100, sampleMs: 200 });
  engine.render.request('world-overlay');
  engine.fake.frame();
  tick(50);
  engine.render.request('world-overlay');
  engine.fake.frame();
  tick(50);
  tick(50);
  engine.render.request('hud');
  engine.fake.frame();
  tick(200);
  const result = await pending;
  assert.equal(result.settleMs, 150);
  assert.equal(result.renders, 1);
  assert.equal(result.settlingRequests['world-overlay'].count, 2);
  assert.equal(result.requests.hud.count, 1);
  assert.equal(result.framesWithPendingTiles, 0);
  assert.equal(engine.fake.callsOf('render.request').length, 3);
  assert.equal(engine.render.request, original);
  assert.equal(engine.frames.postRender.numberOfListeners, 0);
  tick(1000);
  assert.equal(engine.fake.callsOf('render.request').length, 3);
});

test('persistent render demand fails with its reason and releases instrumentation', async (t) => {
  const { engine, page, tick } = fixture(t);
  const original = engine.render.request;
  const pending = measureIdleRender(page, { quietMs: 100, timeoutMs: 300 });
  const rejected = assert.rejects(pending, /idle render.*world-overlay/);
  for (let i = 0; i < 6; i++) {
    engine.render.request('world-overlay');
    engine.fake.frame();
    tick(50);
  }
  await rejected;
  assert.equal(engine.render.request, original);
  assert.equal(engine.frames.postRender.numberOfListeners, 0);
  assert.equal(engine.fake.callsOf('render.request').length, 6);
});

test('continuous mode and pending tiles cannot masquerade as idle', async (t) => {
  for (const condition of ['continuous', 'tiles']) {
    await t.test(condition, async (t) => {
      const { engine, page, tick } = fixture(t);
      if (condition === 'continuous') engine.render.setContinuous(true);
      else t.mock.method(engine.surface, 'tilesLoaded', () => false);
      const pending = measureIdleRender(page, { quietMs: 100, timeoutMs: 300 });
      const rejected = assert.rejects(
        pending,
        /Readiness timeout: idle render/,
      );
      tick(300);
      await rejected;
      assert.equal(engine.fake.callsOf('render.request').length, 0);
    });
  }
});

test('engine destruction stops the idle observer', async (t) => {
  const { engine, page, tick } = fixture(t);
  const original = engine.render.request;
  const pending = measureIdleRender(page);
  const rejected = assert.rejects(pending, /engine changed/);
  engine.destroy();
  tick(50);
  await rejected;
  assert.equal(engine.render.request, original);
});

test('renders during the sample stay counted even when demand becomes continuous', async (t) => {
  const { engine, page, tick } = fixture(t);
  const pending = measureIdleRender(page, { quietMs: 100, sampleMs: 500 });
  tick(100);
  for (let i = 0; i < 10; i++) {
    engine.render.request('world-overlay');
    engine.fake.frame();
    tick(50);
  }
  const result = await pending;
  assert.equal(result.renders, 10);
  assert.equal(result.requests['world-overlay'].count, 10);
});
