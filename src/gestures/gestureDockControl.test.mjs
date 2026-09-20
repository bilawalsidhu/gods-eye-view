import test from 'node:test';
import assert from 'node:assert/strict';
import { createGestureDockControl } from './gestureDockControl.js';

test('createGestureDockControl handles SSR/Node environments without errors', () => {
  const control = createGestureDockControl();
  assert.ok(control);
  assert.ok(control.controller);
  assert.equal(typeof control.destroy, 'function');
  control.destroy();
});
