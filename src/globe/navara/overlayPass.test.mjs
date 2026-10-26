import assert from 'node:assert/strict';
import test from 'node:test';
import { Scene, PerspectiveCamera } from 'three';
import { GevOverlayPass } from './overlayPass.js';
test('overlay draws in place only with visible objects and restores renderer state on failure', () => {
  let active = false;
  const overlay = {
    hasDrawables: () => active,
    uniforms: { uGevResolution: { value: [0, 0] } },
  };
  const pass = new GevOverlayPass(
    new Scene(),
    new PerspectiveCamera(),
    overlay,
  );
  const input = { width: 1280, height: 800 };
  let target,
    renders = 0;
  const renderer = {
    autoClear: true,
    setRenderTarget: (value) => {
      target = value;
    },
    render: () => {
      renders++;
    },
  };
  pass.render(renderer, input);
  assert.equal(renders, 0);
  active = true;
  pass.render(renderer, input);
  assert.equal(target, input);
  assert.equal(renders, 1);
  assert.equal(pass.needsSwap, false);
  assert.equal(renderer.autoClear, true);
  assert.deepEqual(overlay.uniforms.uGevResolution.value, [1280, 800]);
  renderer.render = () => {
    throw new Error('render failed');
  };
  assert.throws(() => pass.render(renderer, input), /render failed/);
  assert.equal(renderer.autoClear, true);
  pass.dispose();
});
