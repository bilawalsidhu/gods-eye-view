import test from 'node:test';
import assert from 'node:assert/strict';
import { createFocusReturn } from './focusReturn.js';

test('focus captures the pre-navigation view and restores it exactly once', () => {
  let camera = {
    position: [1.123456789, 2, 3],
    direction: [0, 0, -1],
    up: [0, 1, 0],
  };
  const original = structuredClone(camera);
  const states = [];
  const history = createFocusReturn({
    capture: () => structuredClone(camera),
    restore: (value) => {
      camera = value;
    },
    publish: (value) => states.push(value),
  });
  assert.equal(
    history.focus(() => {
      camera = { position: [4, 5, 6] };
      return true;
    }),
    true,
  );
  assert.equal(history.back(), true);
  assert.deepEqual(camera, original);
  assert.equal(history.back(), false);
  assert.deepEqual(states, [true, false]);
});
test('a refused focus keeps the earlier return view, and repeated focus stores the latest view', () => {
  let camera = 'overview';
  const history = createFocusReturn({
    capture: () => camera,
    restore: (value) => {
      camera = value;
    },
  });
  history.focus(() => {
    camera = 'one';
  });
  history.focus(() => false);
  history.back();
  assert.equal(camera, 'overview');
  history.focus(() => {
    camera = 'one';
  });
  history.focus(() => {
    camera = 'two';
  });
  history.back();
  assert.equal(camera, 'one');
});
