import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputRouter } from './router.js';

const router = (options = {}) =>
  createInputRouter({
    report: (error) => {
      throw error;
    },
    suspendCamera: () => () => {},
    ...options,
  });

const ev = (type, x = 10, y = 10, button = 0) => ({
  type,
  position: { x, y },
  button,
  modifiers: { shift: false, ctrl: false, alt: false, meta: false },
  timestamp: 0,
  pointerType: 'mouse',
});

test('a behaviour turns off at its first hold and on at its last release', () => {
  const told = [];
  const { port } = router({
    onBehaviour: (name, enabled) => told.push([name, enabled]),
  });
  const a = port.behaviours.select.suppress();
  const b = port.behaviours.select.suppress();
  assert.equal(port.behaviours.select.enabled, false);
  a();
  a();
  assert.deepEqual(told, [['select', false]], 'one hold still out');
  b();
  assert.equal(port.behaviours.select.enabled, true);
  assert.deepEqual(told, [
    ['select', false],
    ['select', true],
  ]);
  assert.equal(port.behaviours.dblclickFollow.enabled, true, 'separate');
});

test('extra behaviours are listed; unsupported ones read disabled', () => {
  const { port } = router({
    behaviours: ['dblclickZoom'],
    supported: { dblclickFollow: false },
  });
  assert.deepEqual(Object.keys(port.behaviours), [
    'select',
    'dblclickFollow',
    'dblclickZoom',
  ]);
  assert.equal(port.behaviours.dblclickFollow.enabled, false);
  assert.equal(port.behaviours.dblclickZoom.enabled, true);
});

test('an unsupported behaviour is never told; a throwing hook is reported', () => {
  const told = [];
  const errors = [];
  const { port } = router({
    report: (error) => errors.push(error),
    supported: { dblclickFollow: false },
    onBehaviour: (name, enabled) => {
      told.push([name, enabled]);
      if (name === 'select') throw new Error('hook');
    },
  });
  port.behaviours.dblclickFollow.suppress()();
  assert.deepEqual(told, []);
  const release = port.behaviours.select.suppress();
  assert.equal(typeof release, 'function', 'the hold is still handed out');
  assert.equal(port.behaviours.select.enabled, false);
  release();
  assert.equal(port.behaviours.select.enabled, true);
  assert.equal(errors.length, 2);
});

test('ctrlWheelZoom is told to the renderer', () => {
  const told = [];
  const { port } = router({ onCtrlWheelZoom: (on) => told.push(on) });
  assert.equal(port.ctrlWheelZoom, false);
  port.ctrlWheelZoom = 1;
  assert.equal(port.ctrlWheelZoom, true);
  assert.deepEqual(told, [true]);
});

test('dispatch says who an event went to', () => {
  const { port, dispatch, listenerCount } = router();
  const off = port.on('down', () => {});
  assert.equal(listenerCount(), 1);
  assert.deepEqual(dispatch(ev('down')), { lease: null, ambient: true });
  dispatch(ev('up'));
  const lease = port.claimPointer('tool', {
    grab: (down) => down.button === 2,
  });
  assert.deepEqual(dispatch(ev('down')), { lease: null, ambient: true });
  dispatch(ev('up'));
  assert.deepEqual(dispatch(ev('down', 10, 10, 2)), {
    lease,
    ambient: false,
  });
  off();
  assert.equal(listenerCount(), 0);
});

test('camera holds go to the renderer, reason as a string', () => {
  const reasons = [];
  const { port } = router({
    suspendCamera: (reason) => {
      reasons.push(reason);
      return () => {};
    },
  });
  port.suspendCameraControls(7);
  assert.deepEqual(reasons, ['7']);
});
