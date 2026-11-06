import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireCameraInput } from './cameraInput.js';

test('users of one scene share its holds', () => {
  const controller = { enableInputs: true };
  const scene = { screenSpaceCameraController: controller };
  const a = acquireCameraInput(scene);
  const b = acquireCameraInput(scene);
  const drag = a.suspend('drag');
  assert.equal(controller.enableInputs, false);
  assert.equal(b.enabled, false, 'b sees a’s hold');
  assert.deepEqual(b.reasons(), ['drag']);
  const flight = b.suspend(7);
  assert.deepEqual(a.reasons(), ['drag', '7']);
  drag();
  assert.equal(controller.enableInputs, false, 'b’s hold is still out');
  a.release();
  assert.equal(controller.enableInputs, false, 'b still holds');
  flight();
  assert.equal(controller.enableInputs, true);
});

test('releasing a user gives back its holds, and the property with the last', () => {
  const controller = { enableInputs: true };
  const scene = { screenSpaceCameraController: controller };
  const a = acquireCameraInput(scene);
  const b = acquireCameraInput(scene);
  a.suspend('drag');
  b.suspend('cockpit');
  a.release();
  assert.deepEqual(b.reasons(), ['cockpit']);
  assert.equal(
    typeof Object.getOwnPropertyDescriptor(controller, 'enableInputs').get,
    'function',
    'still owned while b is a user',
  );
  b.release();
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(controller, 'enableInputs'),
    {
      value: true,
      writable: true,
      enumerable: true,
      configurable: true,
    },
  );
  assert.deepEqual(
    a.suspend('late')(),
    undefined,
    'a released user holds nothing',
  );
  const c = acquireCameraInput(scene);
  assert.equal(c.enabled, true, 'a new user starts afresh');
  c.release();
});
