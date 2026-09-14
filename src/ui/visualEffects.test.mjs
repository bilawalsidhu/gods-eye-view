import assert from 'node:assert/strict';
import test from 'node:test';
import { VisualEffects } from './visualEffects.js';
import {
  GLOBAL_POST_DEFAULTS,
  STYLE_PRESET_DEFAULTS,
  MILITARY_DETECTION_PRESET,
} from './visualPresets.js';

function fixture() {
  let time = 0;
  let next = 0;
  const frames = new Map();
  const stages = new Set();
  const holds = new Set();
  const requests = [];
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
  const originalBloom = structuredClone(bloom);
  const pipeline = {
    bloom,
    add(stage) {
      stages.add(stage);
    },
    remove(stage) {
      return stages.delete(stage);
    },
  };
  const effects = new VisualEffects({
    viewer: { scene: { postProcessStages: pipeline } },
    requestRender: (reason) => requests.push(reason),
    holdRender: (reason) => holds.add(reason),
    releaseRender: (reason) => holds.delete(reason),
    requestFrame: (callback) => {
      const id = next++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
    now: () => time,
    wallNow: () => 10_000 + time,
    createStage: (options) => ({ ...options, enabled: true }),
  });
  function tick(value) {
    time = value;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback();
  }
  return {
    effects,
    frames,
    stages,
    holds,
    requests,
    bloom,
    originalBloom,
    tick,
  };
}

test('construction is inert and initialization creates one owned pipeline', () => {
  const f = fixture();
  assert.equal(f.stages.size, 0);
  assert.equal(f.frames.size, 0);
  f.effects.initStyles();
  f.effects.initPostProcess();
  assert.equal(f.stages.size, 7);
  assert.ok(
    Object.values(f.effects.stages).every(
      (stage) => !stage.enabled && stage.uniforms.intensity === 0,
    ),
  );
  f.effects.initStyles();
  f.effects.initPostProcess();
  assert.equal(f.stages.size, 7);
  f.effects.destroy();
});

test('crossfade uses the established 500ms easing and settles without idle frames', () => {
  const f = fixture();
  f.effects.initStyles();
  f.effects.startTransition('noir', 0, 1);
  assert.equal(f.effects.frameId, 0, 'zero is a valid pending animation id');
  f.effects.startAnimationLoop();
  assert.equal(
    f.frames.size,
    1,
    'starting twice cannot schedule duplicate frames',
  );
  f.tick(125);
  assert.equal(f.effects.stages.noir.uniforms.intensity, 0.125);
  f.tick(250);
  assert.equal(f.effects.stages.noir.uniforms.intensity, 0.5);
  f.tick(500);
  assert.equal(f.effects.stages.noir.uniforms.intensity, 1);
  assert.equal(f.effects.transitions.size, 0);
  // Noir's shader has no animated time uniform.
  assert.equal(f.frames.size, 0);
  assert.equal(f.holds.size, 0);
  f.effects.destroy();
});

test('a superseding transition starts from the current rendered intensity', () => {
  const f = fixture();
  f.effects.initStyles();
  f.effects.startTransition('noir', 0, 1);
  f.tick(250);
  f.effects.startTransition(
    'noir',
    f.effects.stages.noir.uniforms.intensity,
    0,
  );
  f.tick(500);
  assert.equal(f.effects.stages.noir.uniforms.intensity, 0.25);
  f.tick(750);
  assert.equal(f.effects.stages.noir.uniforms.intensity, 0);
  assert.equal(f.effects.stages.noir.enabled, false);
  assert.equal(f.frames.size, 0);
  f.effects.destroy();
});

test('only visible animated stages keep the animation clock and render hold alive', () => {
  const f = fixture();
  f.effects.initStyles();
  const animated = f.effects.stages.retro;
  assert.notEqual(animated.uniforms.time, undefined);
  f.effects.setStageIntensity(animated, 1);
  f.tick(1000);
  assert.equal(animated.uniforms.time, 1);
  assert.equal(f.frames.size, 1);
  assert.equal(f.holds.size, 1);
  f.effects.setStageIntensity(animated, 0);
  f.tick(1100);
  assert.equal(f.frames.size, 0);
  assert.equal(f.holds.size, 0);
  f.effects.destroy();
});

test('direct Cockpit intensity writes are reconciled before rendering', () => {
  const f = fixture();
  f.effects.initStyles();
  f.effects.stages.thermal.uniforms.intensity = 1;
  f.effects.syncStagesEnabledFromIntensity();
  assert.equal(f.effects.stages.thermal.enabled, true);
  f.effects.stages.thermal.uniforms.intensity = 0;
  f.effects.syncStagesEnabledFromIntensity();
  assert.equal(f.effects.stages.thermal.enabled, false);
  f.effects.destroy();
});

test('bloom retains its dead zone, normalized intensity and independent toggle', () => {
  const f = fixture();
  f.effects.initPostProcess();
  f.effects.setBloomEnabled(true);
  f.effects.applyBloomIntensity(0);
  assert.equal(f.bloom.enabled, false);
  f.effects.applyBloomIntensity(200);
  assert.equal(f.bloom.enabled, true);
  assert.equal(f.bloom.uniforms.contrast, 87);
  f.effects.setBloomEnabled(false);
  assert.equal(f.effects.bloomIntensity, 200);
  assert.equal(f.bloom.enabled, false);
  f.effects.applyBloomIntensity(300);
  assert.equal(f.effects.bloomIntensity, 200);
  f.effects.destroy();
});

test('sharpen uses the existing uniform scale and keeps values while disabled', () => {
  const f = fixture();
  f.effects.initPostProcess(0.49);
  assert.equal(f.effects.sharpenStage.uniforms.amount, 1.08);
  f.effects.applySharpenIntensity(1);
  f.effects.setSharpenEnabled(true);
  assert.equal(f.effects.sharpenStage.uniforms.amount, 2.1);
  assert.equal(f.effects.sharpenStage.enabled, true);
  f.effects.setSharpenEnabled(false);
  assert.equal(f.effects.sharpenIntensity, 1);
  assert.equal(f.effects.sharpenStage.enabled, false);
  f.effects.destroy();
});

test('stop revokes pending work immediately but retains stages until final destruction', () => {
  const f = fixture();
  f.effects.initStyles();
  f.effects.initPostProcess();
  f.effects.startTransition('retro', 0, 1);
  const staleFrame = [...f.frames.values()][0];
  f.effects.stop();
  assert.equal(f.frames.size, 0);
  assert.equal(
    f.stages.size,
    7,
    'Context and Cockpit may still be releasing these stages',
  );
  const intensity = f.effects.stages.retro.uniforms.intensity;
  staleFrame();
  f.effects.startTransition('retro', 0, 1);
  f.effects.setStageIntensity(f.effects.stages.retro, 1);
  assert.equal(f.frames.size, 0);
  assert.equal(f.effects.stages.retro.uniforms.intensity, intensity);
  f.effects.destroy();
  assert.equal(f.stages.size, 0);
  assert.deepEqual(
    f.bloom,
    f.originalBloom,
    'borrowed bloom configuration is restored',
  );
  f.effects.destroy();
});

test('destroying one instance does not remove another pipeline or clock', () => {
  const a = fixture();
  const b = fixture();
  for (const f of [a, b]) {
    f.effects.initStyles();
    f.effects.startTransition('retro', 0, 1);
  }
  a.effects.destroy();
  b.tick(250);
  assert.equal(a.stages.size, 0);
  assert.equal(b.stages.size, 6);
  assert.equal(b.effects.stages.retro.uniforms.intensity, 0.5);
  b.effects.destroy();
});

test('existing baseline and military presets keep one detection default', () => {
  assert.equal(GLOBAL_POST_DEFAULTS.detectionMode, 'DENSE');
  assert.equal(GLOBAL_POST_DEFAULTS.detectionDensity, 75);
  assert.equal(GLOBAL_POST_DEFAULTS.sharpen.intensity, 49);
  assert.equal(GLOBAL_POST_DEFAULTS.detectionFadePct, 7);
  assert.equal(GLOBAL_POST_DEFAULTS.detectionOutsideOpacityPct, 1);
  for (const name of ['retro', 'surveillance', 'thermal']) {
    assert.equal(
      STYLE_PRESET_DEFAULTS[name].detection,
      MILITARY_DETECTION_PRESET,
    );
  }
  assert.equal(STYLE_PRESET_DEFAULTS.normal, undefined);
});
