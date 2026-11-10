import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewport } from './viewport.js';
import { LOD_CHECK_MS } from './policy.js';

function signal() {
  const listeners = new Set();
  return {
    addEventListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    raise() {
      for (const listener of [...listeners]) listener();
    },
    get size() {
      return listeners.size;
    },
  };
}
function harness() {
  const moveEnd = signal(),
    preRender = signal(),
    requests = [];
  const engine = createFakeEngine();
  engine.camera.moveEnd = moveEnd;
  engine.frames.preRender = preRender;
  const layerState = {
    _enabled: true,
    _destroyed: false,
    _view: { camera: {} },
    _renderer: { engine: engine },
  };
  const viewport = createViewport({
    layerState,
    services: {
      render: { governorRequestRender: (reason) => requests.push(reason) },
    },
    components: {},
    config: {},
  });
  viewport.installLodWatcher();
  return { viewport, layerState, moveEnd, preRender, requests };
}
for (const operation of ['disable', 'destroy']) {
  test(`FIRMS ${operation} cancels its pending settled-camera frame`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    h.moveEnd.raise();
    h.layerState._enabled = false;
    if (operation === 'destroy') h.layerState._destroyed = true;
    h.viewport.removeLodWatcher();
    t.mock.timers.tick(LOD_CHECK_MS + 100);
    assert.deepEqual(h.requests, [], 'removed layer must never wake the scene');
    assert.equal(h.moveEnd.size, 0);
    assert.equal(h.preRender.size, 0);
  });
}
test('FIRMS coalesces repeated moveEnd events into one final settled frame', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.moveEnd.raise();
  t.mock.timers.tick(300);
  h.moveEnd.raise();
  t.mock.timers.tick(LOD_CHECK_MS + 40 - 300);
  assert.deepEqual(h.requests, [], 'the earlier settle request was superseded');
  t.mock.timers.tick(300);
  assert.deepEqual(h.requests, ['firms-lod-settle']);
  h.viewport.removeLodWatcher();
});
test('FIRMS active layer still gets the requested final LOD frame', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.moveEnd.raise();
  t.mock.timers.tick(LOD_CHECK_MS + 39);
  assert.deepEqual(h.requests, []);
  t.mock.timers.tick(1);
  assert.deepEqual(h.requests, ['firms-lod-settle']);
  h.viewport.removeLodWatcher();
});
