import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProjection } from './projection.js';

function setup(t) {
  let next = 0;
  const raf = new Map();
  const timers = new Map();
  const originals = new Map();
  for (const [name, value] of Object.entries({
    requestAnimationFrame: (fn) => {
      raf.set(++next, fn);
      return next;
    },
    cancelAnimationFrame: (id) => raf.delete(id),
    setTimeout: (fn) => {
      timers.set(++next, fn);
      return next;
    },
    clearTimeout: (id) => timers.delete(id),
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const holds = new Set();
  const requests = [];
  let uploads = 0;
  let dirty = false;
  let focus = false;
  const record = { projection: { mode: 'image', disposed: false } };
  const state = {
    _enabled: true,
    _viewer: {},
    _showProjection: true,
    _projectionRaf: 0,
    _projectionTimer: 0,
    _activeFocusStyleCount: 0,
  };
  const projection = createProjection({
    state,
    services: {
      render: {
        holdContinuousRender: (id) => holds.add(id),
        releaseContinuousRender: (id) => holds.delete(id),
        governorRequestRender: (reason) => requests.push(reason),
      },
      focus: {
        getFocusTarget: () => (focus ? {} : null),
        focusPassIsNeeded: (target) => !!target,
      },
    },
    parts: {
      renderer: { ready: true },
      model: { projectionLoopIsNeeded: () => state._enabled },
      selection: { getActiveRecord: () => record },
      rendering: { refreshCctvFocusStyles() {} },
      frames: {
        drawProjectionFrame() {},
        refreshProjectionTextures() {
          if (!dirty) return;
          dirty = false;
          uploads++;
          return true;
        },
      },
    },
  });
  t.after(() => {
    projection.stopProjectionLoop();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  function run(queue) {
    const [id, fn] = queue.entries().next().value || [];
    assert.equal(typeof fn, 'function', 'scheduled work exists');
    queue.delete(id);
    fn();
  }
  return {
    projection,
    state,
    record,
    holds,
    requests,
    raf,
    timers,
    frame: () => run(raf),
    timer: () => run(timers),
    changeImage: () => {
      dirty = true;
    },
    focus: (value) => {
      focus = value;
    },
    uploads: () => uploads,
  };
}

test('an unchanged still keeps fetching cadence without holding or requesting GPU frames', (t) => {
  const h = setup(t);
  h.projection.startProjectionLoop();
  assert.equal(h.holds.size, 0);
  h.frame();
  for (let i = 0; i < 20; i++) h.timer();
  assert.equal(h.raf.size, 0);
  assert.equal(h.holds.size, 0);
  assert.deepEqual(h.requests, []);
  h.changeImage();
  h.timer();
  assert.equal(h.uploads(), 1);
  assert.deepEqual(h.requests, ['cctv-projection-image']);
  h.timer();
  assert.equal(h.requests.length, 1);
});

test('video and focus fades retain continuous rendering, then a still releases it', (t) => {
  const h = setup(t);
  h.record.projection.video = {};
  h.projection.startProjectionLoop();
  h.frame();
  assert.deepEqual([...h.holds], ['cctv-projection']);
  assert.equal(h.timers.size, 0);
  h.record.projection.video = null;
  h.focus(true);
  h.frame();
  assert.equal(h.holds.size, 1);
  h.focus(false);
  h.frame();
  assert.equal(h.holds.size, 0);
  assert.equal(h.raf.size, 0);
  assert.equal(h.timers.size, 1);
});

test('stopping cancels a still timer and a retired callback cannot restart it', (t) => {
  const h = setup(t);
  h.projection.startProjectionLoop();
  h.frame();
  const retired = [...h.timers.values()][0];
  h.projection.stopProjectionLoop();
  assert.equal(h.timers.size, 0);
  retired();
  assert.equal(h.raf.size + h.timers.size, 0);
  h.projection.startProjectionLoop();
  h.frame();
  retired();
  assert.equal(h.timers.size, 1);
  h.state._enabled = false;
  h.timer();
  assert.equal(h.raf.size + h.timers.size + h.holds.size, 0);
});

test('a newly tracked focus wakes a sleeping still without waiting for its next timer', (t) => {
  const h = setup(t);
  h.projection.startProjectionLoop();
  h.frame();
  const retired = [...h.timers.values()][0];
  h.focus(true);
  h.projection.startProjectionLoop();
  assert.equal(h.timers.size, 0);
  retired();
  assert.equal(h.raf.size, 1);
  h.frame();
  assert.equal(h.holds.size, 1);
});
