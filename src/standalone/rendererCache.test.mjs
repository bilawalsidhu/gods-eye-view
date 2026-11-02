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
    return {
      suspend() {
        this.running = false;
      },
      resume() {
        this.running = true;
      },
      engine: {
        host: { container, canvas: new EventTarget() },
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
  assert.equal(await open(), first);
  assert.equal(first.running, true);
  assert.equal(first.engine.host.container.isConnected, true);
  cache.retain('navara');
  release();
  first.engine.host.canvas.dispatchEvent(new Event('webglcontextlost'));
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
  const third = await open();
  third.suspend = () => {
    throw new Error('suspend failed');
  };
  cache.retain('navara');
  assert.throws(release, /suspend failed/);
  assert.equal(third.engine.host.container.isConnected, false);
  cache.clear();
  assert.equal(released, 3);
});
