import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraReconstructionUI } from './cameraReconstructionUI.js';
test('whole and selected generation inputs use pristine frame pixels, excluding added caption and annotations', () => {
  const original = { width: 480, height: 334 },
    calls = [];
  let scope = 'whole';
  const ui = Object.create(CameraReconstructionUI.prototype);
  ui.section = { querySelector: () => ({ value: scope }) };
  ui.snapshot = {
    original,
    frameHeight: 270,
    getSelection: () => ({
      pixelBounds: { x: 100, y: 200, width: 120, height: 130 },
    }),
    doc: {
      createElement: () => ({
        getContext: () => ({ drawImage: (...args) => calls.push(args) }),
      }),
    },
  };
  let input = ui.input();
  assert.equal(input.canvas.width, 480);
  assert.equal(input.canvas.height, 270);
  assert.equal(calls[0][0], original);
  scope = 'region';
  input = ui.input();
  assert.deepEqual(input.bounds, { x: 100, y: 200, width: 120, height: 70 });
  assert.equal(input.canvas.height, 70);
  assert.equal(calls[1][0], original);
});
