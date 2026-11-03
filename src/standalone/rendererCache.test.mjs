import assert from 'node:assert/strict';
import test from 'node:test';
import { createRendererCache } from './rendererCache.js';

test('a parked renderer is reused, but a lost context is disposed before rebuilding', async (t) => {
  const host = {
    prepend: (el) => {
      el.isConnected = true;
    },
  };
  const saved = globalThis.document;
  globalThis.document = {
    getElementById: () => host,
    createElement: () => ({
      remove() {
        this.isConnected = false;
      },
    }),
  };
  t.after(() => {
    globalThis.document = saved;
  });
  const cache = createRendererCache();
  let released = 0;
  let release;
  const build = ({ container, defer }) => {
    defer(() => {
      released += 1;
    });
    const canvas = new EventTarget();
    const context = { lost: false, isContextLost: () => context.lost };
    canvas.getContext = (type) => (type === 'webgl2' ? context : null);
    return {
      context,
      suspend() {
        this.running = false;
      },
      resume() {
        this.running = true;
      },
      engine: {
        host: { container, canvas },
        render: { request() {} },
      },
    };
  };
  const open = () =>
    cache.acquire('navara', build, (stop) => {
      release = stop;
    });
  const first = await open();
  cache.retain('navara');
  release();
  assert.equal(first.running, false);
  assert.equal(first.engine.host.container.isConnected, false);
  // A parked renderer whose canvas no longer hands out contexts is still
  // reused when its own context is alive.
  first.engine.host.canvas.getContext = () => {
    throw new Error('getContext called during a switch');
  };
  assert.equal(await open(), first);
  assert.equal(first.running, true);
  assert.equal(first.engine.host.container.isConnected, true);
  cache.retain('navara');
  release();
  // The WebGL context is already lost, but its DOM event has not fired.
  // The switch reads the context the globe was built with and never asks
  // the canvas again (a QA or driver failure of getContext must not decide).
  first.context.lost = true;
  first.engine.host.canvas.getContext = () => {
    throw new Error('getContext called during a switch');
  };
  const second = await open();
  assert.notEqual(second, first);
  assert.equal(released, 1);
  cache.retain('navara');
  release();
  second.resume = () => {
    throw new Error('resume failed');
  };
  await assert.rejects(open(), /resume failed/);
  assert.equal(second.engine.host.container.isConnected, false);
  assert.equal(released, 2);
  const eventLost = await open();
  cache.retain('navara');
  release();
  eventLost.engine.host.canvas.dispatchEvent(new Event('webglcontextlost'));
  const third = await open();
  assert.notEqual(third, eventLost);
  assert.equal(released, 3);
  third.suspend = () => {
    throw new Error('suspend failed');
  };
  cache.retain('navara');
  assert.throws(release, /suspend failed/);
  assert.equal(third.engine.host.container.isConnected, false);
  cache.clear();
  assert.equal(released, 4);
});
