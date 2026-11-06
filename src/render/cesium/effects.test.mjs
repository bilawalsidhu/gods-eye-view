import assert from 'node:assert/strict';
import test from 'node:test';
import { bloomUniforms, createCesiumEffects } from './effects.js';

const ALL = new Set(['styles', 'bloom', 'sharpen']);

function fixture({ capabilities = ALL } = {}) {
  const stages = [];
  const removed = [];
  const bloom = {
    enabled: true,
    uniforms: {
      glowOnly: true,
      contrast: 3,
      brightness: 4,
      delta: 5,
      sigma: 6,
      stepSize: 7,
    },
  };
  const original = structuredClone(bloom);
  const scene = {
    postProcessStages: {
      bloom,
      add: (stage) => stages.push(stage),
      remove(stage) {
        const i = stages.indexOf(stage);
        if (i < 0) return false;
        stages.splice(i, 1);
        removed.push(stage);
        return true;
      },
    },
  };
  const holds = [];
  const requests = [];
  const preRender = new Set();
  const frame = {
    on(phase, cb) {
      assert.equal(phase, 'preRender');
      preRender.add(cb);
      return () => preRender.delete(cb);
    },
    holdContinuous(reason) {
      const hold = { reason, live: true };
      holds.push(hold);
      return () => (hold.live = false);
    },
    requestRender: (reason) => requests.push(reason),
  };
  const part = createCesiumEffects(scene, {
    capabilities,
    frame,
    report: (error) => {
      throw error;
    },
    createStage: (options) => ({ ...options, enabled: true }),
  });
  return {
    effects: part.port,
    dispose: part.dispose,
    stages,
    removed,
    bloom,
    original,
    requests,
    liveHolds: () => holds.filter((h) => h.live).map((h) => h.reason),
    render(now) {
      for (const cb of [...preRender]) cb({ now });
    },
    preRender,
  };
}

const style = (id, extra = {}) => ({
  id,
  params: [{ key: 'grain', min: 0, max: 1, default: 0.25 }],
  animated: false,
  shader: { glsl: `void main() { out_FragColor = vec4(0.0); }` },
  ...extra,
});

const stageOf = (f, id) =>
  f.stages.find((s) => s.name === `effects_style_${id}`);

test('building the port changes nothing in the scene', () => {
  const f = fixture();
  assert.equal(f.stages.length, 0);
  assert.deepEqual(f.bloom, f.original);
  assert.deepEqual(f.effects.diagnostics(), { style: null, passes: [] });
});

test('a defined style is one disabled stage with its uniforms', () => {
  const f = fixture();
  const off = f.effects.defineStyle(style('retro'));
  assert.equal(typeof off, 'function');
  assert.equal(f.stages.length, 1);
  const stage = stageOf(f, 'retro');
  assert.equal(stage.fragmentShader, style('retro').shader.glsl);
  assert.deepEqual(stage.uniforms, { intensity: 1, time: 0, grain: 0.25 });
  assert.equal(stage.enabled, false);
  assert.deepEqual(f.effects.styles(), [
    {
      id: 'retro',
      params: [{ key: 'grain', min: 0, max: 1, default: 0.25 }],
      animated: false,
    },
  ]);
  off();
  assert.equal(f.stages.length, 0);
  assert.deepEqual(f.effects.styles(), []);
});

test('reserved or malformed parameter keys are refused', () => {
  const f = fixture();
  for (const key of ['time', 'intensity', 'colorTexture', '1x', 'a-b'])
    assert.throws(
      () =>
        f.effects.defineStyle(
          style('x', { params: [{ key, min: 0, max: 1, default: 0 }] }),
        ),
      TypeError,
    );
  assert.equal(f.stages.length, 0);
});

test('setStyle enables the style; intensity and params reach the stage', () => {
  const f = fixture();
  f.effects.defineStyle(style('retro'));
  const changes = [];
  f.effects.on('change', (d) => changes.push(d));
  f.effects.setStyle('retro', { grain: 0.8, unknown: 3 });
  const stage = stageOf(f, 'retro');
  assert.equal(stage.enabled, true);
  assert.equal(stage.uniforms.grain, 0.8);
  assert.equal('unknown' in stage.uniforms, false);
  f.effects.setStyleIntensity('retro', 0.4);
  assert.equal(stage.uniforms.intensity, 0.4);
  f.effects.setStyleParams('retro', { grain: 0.1 });
  assert.equal(stage.uniforms.grain, 0.1);
  f.effects.setStyleIntensity('retro', 0);
  assert.equal(stage.enabled, false, 'no pass at 0');
  assert.deepEqual(f.effects.diagnostics(), { style: 'retro', passes: [] });
  assert.equal(changes.length, 4);
  assert.ok(f.requests.length >= 4);
});

test('a replaced style fades out under the new one', () => {
  const f = fixture();
  f.effects.defineStyle(style('a'));
  f.effects.defineStyle(style('b'));
  f.effects.setStyle('a');
  f.effects.setStyleIntensity('b', 0);
  f.effects.setStyle('b');
  assert.equal(stageOf(f, 'a').enabled, true);
  assert.equal(stageOf(f, 'b').enabled, false);
  f.effects.setStyleIntensity('b', 0.5);
  assert.deepEqual(f.effects.diagnostics().passes, ['style:a', 'style:b']);
  f.effects.setStyleIntensity('a', 0);
  f.effects.setStyleIntensity('a', 1);
  assert.equal(stageOf(f, 'a').enabled, false, 'faded out for good');
  f.effects.setStyle('a');
  assert.deepEqual(f.effects.diagnostics(), {
    style: 'a',
    passes: ['style:a', 'style:b'],
  });
});

test('stages keep definition order, sharpen last', () => {
  const f = fixture();
  f.effects.defineStyle(style('a'));
  f.effects.sharpen({ enabled: true, amount: 0.5 });
  f.effects.defineStyle(style('b'));
  assert.deepEqual(
    f.stages.map((s) => s.name),
    ['effects_style_a', 'effects_style_b', 'effects_sharpen'],
  );
  assert.equal(f.stages[2].enabled, true);
  assert.equal(f.stages[2].uniforms.amount, 1.1);
});

test('a replacement keeps the style on, its intensity and its values', () => {
  const f = fixture();
  const off = f.effects.defineStyle(style('a'));
  f.effects.setStyle('a', { grain: 0.9 });
  f.effects.setStyleIntensity('a', 0.3);
  const offAgain = f.effects.defineStyle(
    style('a', {
      params: [
        { key: 'grain', min: 0, max: 1, default: 0.25 },
        { key: 'fresh', min: 0, max: 1, default: 0.6 },
      ],
    }),
  );
  const stage = stageOf(f, 'a');
  assert.deepEqual(stage.uniforms, {
    intensity: 0.3,
    time: 0,
    grain: 0.9,
    fresh: 0.6,
  });
  assert.equal(stage.enabled, true);
  off();
  assert.equal(f.effects.styles().length, 1, 'the old Off leaves the new');
  offAgain();
  assert.deepEqual(f.effects.diagnostics(), { style: null, passes: [] });
  offAgain();
});

test('an animated style holds frames and advances time only while it draws', () => {
  const f = fixture();
  f.effects.defineStyle(style('anim', { animated: true }));
  f.effects.setStyleIntensity('anim', 0);
  f.effects.setStyle('anim');
  assert.deepEqual(f.liveHolds(), [], 'no hold at 0');
  f.effects.setStyleIntensity('anim', 1);
  assert.deepEqual(f.liveHolds(), ['effects:animated']);
  const stage = stageOf(f, 'anim');
  const before = stage.uniforms.time;
  f.render(performance.now() + 2000);
  assert.ok(stage.uniforms.time >= before + 1.9);
  f.effects.setStyle(null);
  assert.deepEqual(f.liveHolds(), ['effects:animated'], 'fading still draws');
  f.effects.setStyleIntensity('anim', 0);
  assert.deepEqual(f.liveHolds(), []);
  assert.equal(f.preRender.size, 0);
});

test('bloom keeps its dead zone and eased uniforms, and is given back', () => {
  const f = fixture();
  f.effects.bloom({ enabled: true, strength: 0.05 });
  assert.equal(f.bloom.enabled, false, 'below the floor');
  assert.equal(f.bloom.uniforms.glowOnly, false);
  f.effects.bloom({ enabled: true, strength: 0.5 });
  assert.equal(f.bloom.enabled, true);
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(bloomUniforms(0.5)).map((k) => [k, f.bloom.uniforms[k]]),
    ),
    bloomUniforms(0.5),
  );
  f.effects.bloom({ enabled: false });
  assert.equal(f.bloom.enabled, false);
  f.effects.bloom({ enabled: true });
  assert.equal(f.bloom.enabled, true, 'strength kept while off');
  assert.deepEqual(f.effects.diagnostics().passes, ['bloom']);
  f.dispose();
  assert.deepEqual(f.bloom, f.original);
});

test('the bloom mapping matches the eased curve', () => {
  assert.deepEqual(bloomUniforms(0), {
    contrast: 255,
    brightness: -0.5,
    sigma: 0.28,
    delta: 0.2,
    stepSize: 1,
  });
  const full = bloomUniforms(1);
  assert.ok(Math.abs(full.contrast - 87) < 1e-9);
  assert.ok(Math.abs(full.sigma - 6.58) < 1e-9);
});

test('sharpen at 0 runs no pass and keeps its amount while off', () => {
  const f = fixture();
  f.effects.sharpen({ enabled: true, amount: 0 });
  const stage = f.stages.find((s) => s.name === 'effects_sharpen');
  assert.equal(stage.enabled, false);
  assert.equal(stage.uniforms.amount, 0.1);
  f.effects.sharpen({ enabled: false, amount: 0.49 });
  assert.equal(stage.enabled, false);
  f.effects.sharpen({ enabled: true });
  assert.equal(stage.enabled, true);
  assert.ok(Math.abs(stage.uniforms.amount - 1.08) < 1e-9);
});

test('without capabilities nothing is defined or drawn', () => {
  const f = fixture({ capabilities: new Set() });
  assert.equal(f.effects.defineStyle(style('a')), null);
  assert.deepEqual(f.effects.styles(), []);
  f.effects.bloom({ enabled: true, strength: 1 });
  f.effects.sharpen({ enabled: true, amount: 1 });
  assert.equal(f.stages.length, 0);
  assert.deepEqual(f.bloom, f.original);
  assert.equal(
    fixture().effects.defineStyle({ id: 'w', params: [], shader: {} }),
    null,
    'no GLSL',
  );
});

test('dispose removes every stage and releases the clock', () => {
  const f = fixture();
  f.effects.defineStyle(style('anim', { animated: true }));
  f.effects.setStyle('anim');
  f.effects.sharpen({ enabled: true, amount: 1 });
  f.dispose();
  assert.equal(f.stages.length, 0);
  assert.deepEqual(f.liveHolds(), []);
  f.effects.setStyle('anim');
  assert.equal(f.stages.length, 0);
});
