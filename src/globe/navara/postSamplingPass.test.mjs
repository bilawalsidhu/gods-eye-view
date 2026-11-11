import test from 'node:test';
import assert from 'node:assert/strict';
import { DepthTexture, Group, Mesh, Scene, WebGLRenderTarget } from 'three';
import { GeometrySamplingPass } from './postSamplingPass.js';

function fixture() {
  const target = () => {
    const buffer = new WebGLRenderTarget(32, 24, { samples: 4 });
    buffer.depthTexture = new DepthTexture(32, 24);
    return buffer;
  };
  const input = target(),
    output = target();
  let mrt = target();
  const calls = [],
    copies = [],
    draws = [];
  const scenes = { opaque: new Scene(), transparent: new Scene() };
  const passes = Object.fromEntries(
    ['mrt', 'transparent', 'gevOverlay'].map((key) => [
      key,
      {
        scene: new Scene(),
        overlay: { hasDrawables: () => true },
        render(renderer, input, output, ...rest) {
          calls.push({
            key,
            receiver: this,
            input,
            output,
            rest,
            background: this.scene.children[0],
          });
        },
      },
    ]),
  );
  const originals = Object.fromEntries(
    Object.entries(passes).map(([key, pass]) => [key, pass.render]),
  );
  const renderer = {
    autoClear: true,
    setRenderTarget(target) {
      this.target = target;
    },
    render(scene) {
      draws.push(scene);
    },
    initRenderTarget() {},
    copyTextureToTexture(from, to) {
      copies.push([from, to]);
    },
  };
  const ctx = {
    scenes,
    getInputBuffer: () => input,
    getRenderTarget: () => mrt,
    getPass: (key) => passes[key],
  };
  const policy = new GeometrySamplingPass(ctx);
  return {
    policy,
    input,
    output,
    scenes,
    passes,
    originals,
    renderer,
    calls,
    copies,
    draws,
    replaceMrt() {
      mrt = target();
      mrt.samples = 0;
      return mrt;
    },
  };
}

test('post targets use one sample; replacement MRT and actual forward geometry retain four', () => {
  const f = fixture();
  try {
    f.scenes.opaque.add(new Mesh());
    f.policy.render(f.renderer, f.input, f.output);
    assert.equal(f.input.samples, 0);
    assert.equal(f.output.samples, 0);
    const mrt = f.replaceMrt();
    f.policy.render(f.renderer, f.input, f.output);
    assert.equal(mrt.samples, 4);
    f.passes.mrt.render(f.renderer, f.input, f.output, 0.5, false);
    const call = f.calls[0];
    assert.equal(call.receiver, f.passes.mrt);
    assert.equal(call.input.samples, 4);
    assert.notEqual(call.input, f.input);
    assert.deepEqual(call.rest, [0.5, false]);
    assert.deepEqual(f.copies, [
      [call.input.texture, f.input.texture],
      [call.input.depthTexture, f.input.depthTexture],
    ]);
    assert.equal(f.renderer.autoClear, true);
  } finally {
    f.policy.dispose();
  }
});

test('empty forward scenes avoid copies, including hidden geometry', () => {
  const f = fixture();
  try {
    const hidden = new Group();
    hidden.visible = false;
    hidden.add(new Mesh());
    f.scenes.opaque.add(hidden);
    f.passes.gevOverlay.overlay.hasDrawables = () => false;
    f.policy.render(f.renderer, f.input, f.output);
    for (const pass of Object.values(f.passes))
      pass.render(f.renderer, f.input, f.output);
    assert.deepEqual(
      f.calls.map((call) => call.key),
      ['mrt'],
    );
    assert.equal(f.calls[0].input, f.input);
    assert.equal(f.copies.length, 0);
    assert.equal(f.policy.target, null);
    hidden.visible = true;
    f.passes.mrt.render(f.renderer, f.input, f.output);
    assert.equal(f.calls[1].input.samples, 4);
  } finally {
    f.policy.dispose();
  }
});

test('transparent and overlay draws copy the current ping-pong input and keep MSAA after resize', () => {
  const f = fixture();
  try {
    f.scenes.transparent.add(new Mesh());
    f.policy.render(f.renderer, f.input, f.output);
    f.output.setSize(64, 48);
    for (const key of ['transparent', 'gevOverlay']) {
      f.passes[key].render(f.renderer, f.output, f.input);
      assert.equal(f.policy.copy.uniforms.image.value, f.output.texture);
      assert.equal(f.policy.copy.uniforms.depth.value, f.output.depthTexture);
      assert.equal(f.calls.at(-1).input.samples, 4);
      assert.equal(f.calls.at(-1).input.width, 64);
      assert.equal(f.calls.at(-1).input.height, 48);
      assert.deepEqual(f.copies.at(-1), [
        f.policy.target.texture,
        f.output.texture,
      ]);
      assert.equal(f.calls.at(-1).background, f.policy.background);
      assert.equal(f.passes[key].scene.children.length, 0);
    }
    assert.equal(f.draws.length, 0);
    assert.equal(f.renderer.autoClear, true);
  } finally {
    f.policy.dispose();
  }
});

test('disposing restores public passes and buffer sampling without per-frame reallocations', () => {
  const f = fixture();
  let disposals = 0;
  f.input.addEventListener('dispose', () => disposals++);
  f.policy.render(f.renderer, f.input, f.output);
  f.policy.render(f.renderer, f.input, f.output);
  assert.equal(disposals, 1);
  f.policy.dispose();
  assert.equal(disposals, 2);
  assert.equal(f.input.samples, 4);
  assert.equal(f.output.samples, 4);
  for (const key of Object.keys(f.passes))
    assert.equal(f.passes[key].render, f.originals[key]);
});
