import test from 'node:test';
import assert from 'node:assert/strict';
import { Event } from 'cesium';
import { createLaunchHover } from './lifecycle.js';
import {
  bindFakeCesiumCamera,
  fakeCameraPort,
} from '../../testSupport/fakeCameraPort.mjs';
import { bindRenderer } from '../../render/rendererOf.js';

function fakeTimers() {
  const timers = new Map();
  let nextId = 1;
  const api = {
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pending: () => [...timers.values()],
    flush() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, timer] of due) timer.fn();
    },
  };
  return api;
}

function hoverRig({ overMarker }) {
  let at = 0,
    picks = 0,
    enabled = true,
    free = true;
  const timers = fakeTimers();
  const viewer = bindFakeCesiumCamera({
    camera: { moveStart: new Event(), moveEnd: new Event() },
    scene: { canvas: { style: { cursor: '' } } },
  });
  const hover = createLaunchHover({
    viewer,
    enabled: () => enabled,
    launchAt(position) {
      picks++;
      return overMarker(position);
    },
    now: () => at,
    documentRef: { hidden: false },
    pointerFree: () => free,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return {
    hover,
    timers,
    viewer,
    cursor: () => viewer.scene.canvas.style.cursor,
    picks: () => picks,
    setTime: (value) => (at = value),
    setEnabled: (value) => (enabled = value),
    setFree: (value) => (free = value),
  };
}

const onMarker = (position) => position?.x === 1;
const marker = () => ({ endPosition: { x: 1, y: 1 } });
const empty = () => ({ endPosition: { x: 9, y: 9 } });

test('mission hover runs one trailing check for a pointer that stops on empty space', () => {
  const rig = hoverRig({ overMarker: onMarker });
  rig.hover.move(marker());
  assert.equal(rig.cursor(), 'pointer');
  rig.setTime(50);
  const movement = empty();
  rig.hover.move(movement);
  // Cesium reuses its movement object; the trailing check must use a copy.
  movement.endPosition.x = 1;
  assert.equal(rig.picks(), 1);
  assert.deepEqual(
    rig.timers.pending().map((timer) => timer.ms),
    [70],
  );
  rig.setTime(80);
  rig.hover.move(empty());
  assert.equal(rig.timers.pending().length, 1, 'one trailing check at a time');
  rig.setTime(120);
  rig.timers.flush();
  assert.equal(rig.picks(), 2);
  assert.equal(rig.cursor(), '');
  assert.equal(rig.timers.pending().length, 0);
  rig.hover.destroy();
});

test('mission hover trailing check sets the cursor for a pointer that stops on a mission', () => {
  const rig = hoverRig({ overMarker: onMarker });
  rig.hover.move(empty());
  assert.equal(rig.cursor(), '');
  rig.setTime(50);
  rig.hover.move(marker());
  rig.setTime(120);
  rig.timers.flush();
  assert.equal(rig.picks(), 2);
  assert.equal(rig.cursor(), 'pointer');
  rig.hover.destroy();
  assert.equal(rig.cursor(), '');
});

test('mission hover trailing check is cancelled by reset, destroy, and camera motion', () => {
  for (const cancel of [
    (rig) => rig.hover.reset(),
    (rig) => rig.hover.destroy(),
    (rig) => rig.viewer.camera.moveStart.raiseEvent(),
  ]) {
    const rig = hoverRig({ overMarker: onMarker });
    rig.hover.move(empty());
    rig.setTime(50);
    rig.hover.move(marker());
    assert.equal(rig.timers.pending().length, 1);
    cancel(rig);
    assert.equal(rig.timers.pending().length, 0);
    assert.equal(rig.picks(), 1);
    assert.equal(rig.cursor(), '');
    rig.hover.destroy();
  }
});

test('mission hover trailing check rechecks eligibility before picking', () => {
  for (const block of [
    (rig) => rig.setEnabled(false),
    (rig) => rig.setFree(false),
  ]) {
    const rig = hoverRig({ overMarker: onMarker });
    rig.hover.move(marker());
    rig.setTime(50);
    rig.hover.move(marker());
    block(rig);
    rig.setTime(120);
    rig.timers.flush();
    assert.equal(rig.picks(), 1);
    assert.equal(rig.cursor(), '');
    rig.hover.destroy();
  }
});

test('mission hover throttles, clears on motion/hidden, and releases listeners', () => {
  let at = 0,
    picks = 0,
    enabled = true;
  const listeners = new Set();
  const doc = {
    hidden: false,
    addEventListener: (_n, fn) => listeners.add(fn),
    removeEventListener: (_n, fn) => listeners.delete(fn),
  };
  const camera = fakeCameraPort();
  const viewer = {
    get canvas() {
      return this.scene?.canvas;
    },
    scene: { canvas: { style: {} } },
  };
  bindRenderer(viewer, { camera: camera.port });
  const hover = createLaunchHover({
    viewer,
    enabled: () => enabled,
    launchAt() {
      picks++;
      return true;
    },
    now: () => at,
    documentRef: doc,
    pointerFree: () => true,
    ...fakeTimers(),
  });
  for (at = 0; at < 120; at++) hover.move({ endPosition: {} });
  assert.equal(picks, 1);
  assert.equal(viewer.scene.canvas.style.cursor, 'pointer');
  hover.move({ endPosition: {} });
  assert.equal(picks, 2);
  camera.emit('moveStart');
  at = 500;
  hover.move({ endPosition: {} });
  assert.equal(picks, 2);
  assert.equal(viewer.scene.canvas.style.cursor, '');
  camera.emit('moveEnd');
  hover.move({ endPosition: {} });
  assert.equal(picks, 3);
  doc.hidden = true;
  for (const fn of listeners) fn();
  hover.move({ endPosition: {} });
  assert.equal(picks, 3);
  assert.equal(viewer.scene.canvas.style.cursor, '');
  doc.hidden = false;
  enabled = false;
  hover.move({ endPosition: {} });
  assert.equal(picks, 3);
  hover.destroy();
  assert.equal(listeners.size, 0);
  assert.equal(camera.listenerCount('moveStart'), 0);
  assert.equal(camera.listenerCount('moveEnd'), 0);
});

test('mission hover preserves the cursor of a pointer-owning tool', () => {
  let free = true,
    picks = 0;
  const viewer = bindFakeCesiumCamera({
    camera: { moveStart: new Event(), moveEnd: new Event() },
    scene: { canvas: { style: { cursor: '' } } },
  });
  const hover = createLaunchHover({
    viewer,
    enabled: () => true,
    launchAt() {
      picks++;
      return true;
    },
    documentRef: null,
    pointerFree: () => free,
  });
  hover.move({ endPosition: {} });
  assert.equal(viewer.scene.canvas.style.cursor, 'pointer');
  free = false;
  viewer.scene.canvas.style.cursor = 'crosshair';
  hover.move({ endPosition: {} });
  viewer.camera.moveStart.raiseEvent();
  hover.destroy();
  assert.equal(picks, 1);
  assert.equal(viewer.scene.canvas.style.cursor, 'crosshair');
});

test('mission picks are read by the rendering part, which owns the entities', async () => {
  const { createRendering } = await import('./rendering.js');
  const mission = { id: 'rocket-launch:abc' };
  const drilled = [];
  const state = {
    _viewer: {
      scene: {
        drillPick(position, limit) {
          drilled.push([position, limit]);
          return [{ id: { id: 'cable:1' } }, { id: mission }];
        },
      },
    },
  };
  const rendering = createRendering({
    state,
    services: { satellites: {} },
    parts: {},
  });
  assert.equal(rendering.launchMarkerAt({ x: 3, y: 4 }), true);
  assert.deepEqual(drilled, [[{ x: 3, y: 4 }, 12]]);
  assert.equal(
    rendering.launchIdFromPicks([{ id: 'x' }, { id: mission }]),
    'abc',
  );
  assert.equal(rendering.launchIdFromPicks([{ id: 'x' }]), null);
  state._viewer = null;
  assert.equal(rendering.launchMarkerAt({ x: 3, y: 4 }), false);
});
