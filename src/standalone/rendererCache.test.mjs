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
      setRenderLoop(enabled) {
        this.running = enabled;
      },
      engine: {
        host: { container, canvas: new EventTarget() },
        camera: { cancelFlight() {} },
        render: { request() {}, setContinuous() {} },
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
  assert.notEqual(await open(), first);
  assert.equal(released, 1);
  release();
  cache.clear();
  assert.equal(released, 2);
});
