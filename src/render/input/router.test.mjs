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

test('dispose ends delivery, even of the event under way', () => {
  const { port, dispatch, dispose, listenerCount } = router();
  const heard = [];
  // A lease that leaves presses alone, so the down is everyone else's.
  const lease = port.claimPointer('tool', { grab: () => false });
  port.on('down', () => {
    heard.push('a');
    dispose();
  });
  port.on('down', () => heard.push('b'));
  dispatch(ev('down'));
  assert.deepEqual(heard, ['a']);
  assert.equal(listenerCount(), 0);
  assert.equal(lease.current, false, 'the lease ended');
  assert.equal(port.isPointerFree(), true);
});

test('a newer claim takes over and tells the lease it ended, once', () => {
  const { port, dispatch } = router();
  const lost = [];
  const a = port.claimPointer('a', { onLost: () => lost.push('a') });
  const heard = [];
  port.on('down', () => heard.push('a'), { lease: a });
  const b = port.claimPointer('b', {
    onLost: () => lost.push('b'),
  });
  port.on('down', () => heard.push('b'), { lease: b });
  assert.deepEqual(lost, ['a'], 'the old holder is told');
  assert.equal(a.current, false);
  assert.equal(b.current, true);
  dispatch(ev('down'));
  assert.deepEqual(heard, ['b'], 'the newest holder gets the press');
  a.release();
  assert.equal(b.current, true, "the old holder's late release frees nothing");
  assert.equal(port.isPointerFree(), false);
  assert.deepEqual(lost, ['a'], 'told once');
  b.release();
  assert.deepEqual(lost, ['a'], 'a holder that lets go is not told');
  assert.equal(port.isPointerFree(), true);
});

test('the ended lease is told after the new one holds; its error is reported', () => {
  const errors = [];
  const { port } = router({ report: (error) => errors.push(error) });
  let seen = null;
  const a = port.claimPointer('a', {
    onLost: () => {
      seen = { free: port.isPointerFree(), current: a.current };
      throw new Error('onLost');
    },
  });
  const b = port.claimPointer('b');
  assert.deepEqual(seen, { free: false, current: false });
  assert.equal(b.current, true);
  assert.equal(errors.length, 1);
});
