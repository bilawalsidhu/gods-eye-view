import assert from 'node:assert/strict';
import test from 'node:test';
import { VisualEffects } from './visualEffects.js';
import { createCesiumEffects } from '../render/cesium/effects.js';
import { styleStagesOf } from '../styles/styleStages.js';
import { MILKY_WAY_INTENSITY, StarrySky } from '../sky/starrySky.js';
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
  const portHolds = new Set();
  const requests = [];
  const bloom = {
    enabled: false,
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
  const scene = {
    postProcessStages: pipeline,
    skyBox: { milkyWayVisibility: 1 },
  };
  const preRender = new Set();
  const renderer = createCesiumEffects(scene, {
    capabilities: new Set(['styles', 'bloom', 'sharpen']),
    frame: {
      on(phase, cb) {
        preRender.add(cb);
        return () => preRender.delete(cb);
      },
      holdContinuous(reason) {
        const hold = {};
        portHolds.add(hold);
        return () => portHolds.delete(hold);
      },
      requestRender() {},
    },
    report: (error) => {
      throw error;
    },
    createStage: (options) => ({ ...options, enabled: true }),
  });
  const effects = new VisualEffects({
    effects: renderer.port,
    viewer: { scene },
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
  });
  function tick(value) {
    time = value;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback();
  }
  /** The renderer's stage for a style, or sharpen. */
  const stage = (name) =>
    [...stages].find(
      (s) => s.name === `effects_style_${name}` || s.name === `effects_${name}`,
    );
  return {
    effects,
    renderer,
    frames,
    stages,
    stage,
    holds,
    portHolds,
    preRender,
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
  assert.equal(f.stages.size, 6);
  assert.ok(
    Object.values(f.effects.stages).every(
      (stage) => !stage.enabled && stage.uniforms.intensity === 0,
    ),
  );
  f.effects.initStyles();
  f.effects.initPostProcess();
  assert.equal(f.stages.size, 6);
  assert.ok([...f.stages].every((stage) => !stage.enabled));
  assert.equal(styleStagesOf(f.effects.viewer.scene), f.effects.stages);
  f.effects.destroy();
  assert.equal(styleStagesOf(f.effects.viewer.scene), null);
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
  assert.equal(f.stage('noir').uniforms.intensity, 0.5);
  assert.equal(f.stage('noir').enabled, true);
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

test('only visible animated stages keep the renderer’s clock and hold alive', () => {
  const f = fixture();
  f.effects.initStyles();
  const animated = f.effects.stages.retro;
  f.effects.setStageIntensity(animated, 1);
  assert.equal(f.portHolds.size, 1);
  for (const cb of f.preRender) cb({ now: performance.now() + 1000 });
  assert.ok(f.stage('retro').uniforms.time > 0.9);
  assert.equal(f.frames.size, 0, 'no frames of its own');
  f.effects.setStageIntensity(animated, 0);
  assert.equal(f.portHolds.size, 0);
  assert.equal(f.holds.size, 0);
  f.effects.destroy();
});

test('a crossfade draws both styles until the old one reaches 0', () => {
  const f = fixture();
  f.effects.initStyles();
  f.effects.setStageIntensity(f.effects.stages.noir, 1);
  f.effects.startTransition('noir', 1, 0);
  f.effects.startTransition('thermal', 0, 1);
  f.tick(250);
  assert.equal(f.stage('noir').enabled, true);
  assert.equal(f.stage('thermal').enabled, true);
  assert.equal(f.stage('noir').uniforms.intensity, 0.5);
  assert.equal(f.stage('thermal').uniforms.intensity, 0.5);
  f.tick(500);
  assert.equal(f.stage('noir').enabled, false);
  assert.equal(f.stage('thermal').enabled, true);
  // Back again before the first fade-in ends: all three may draw at once.
  f.effects.startTransition('thermal', 1, 0);
  f.effects.startTransition('noir', 0, 1);
  f.tick(600);
  f.effects.startTransition('retro', 0, 1);
  f.tick(700);
  assert.deepEqual(
    ['retro', 'thermal', 'noir'].map((name) => f.stage(name).enabled),
    [true, true, true],
  );
  f.tick(1300);
  assert.deepEqual(
    Object.entries(f.effects.stages)
      .filter(([, stage]) => stage.enabled)
      .map(([name]) => name)
      .sort(),
    ['noir', 'retro'],
  );
  assert.deepEqual(
    ['retro', 'thermal', 'noir'].map((name) => f.stage(name).enabled),
    [true, false, true],
  );
  f.effects.destroy();
});

test('style parameters are written through to the renderer', () => {
  const f = fixture();
  f.effects.initStyles();
  assert.equal(f.effects.stages.thermal.uniforms.pixelation, 1.5);
  f.effects.stages.thermal.uniforms.pixelation = 4;
  assert.equal(f.stage('thermal').uniforms.pixelation, 4);
  assert.equal(f.effects.stages.thermal.uniforms.pixelation, 4);
  assert.equal(f.effects.stages.thermal.uniforms.unknown, undefined);
  f.effects.destroy();
});

test('direct Cockpit intensity writes are reconciled before rendering', () => {
  const f = fixture();
  f.effects.initStyles();
  f.effects.stages.thermal.uniforms.intensity = 1;
  f.effects.syncStagesEnabledFromIntensity();
  assert.equal(f.effects.stages.thermal.enabled, true);
  assert.equal(f.stage('thermal').enabled, true);
  f.effects.stages.thermal.uniforms.intensity = 0;
  f.effects.syncStagesEnabledFromIntensity();
  assert.equal(f.effects.stages.thermal.enabled, false);
  assert.equal(f.stage('thermal').enabled, false);
  f.effects.destroy();
});

test('the anime stage fades the Milky Way out with its own intensity', () => {
  const f = fixture();
  const sky = new StarrySky({ requestRender: () => {} });
  const glow = () => sky._milkyWayUniforms.u_intensity();
  f.effects.viewer.scene.skyBox = sky;
  f.effects.initStyles();
  f.effects.setStageIntensity(f.effects.stages.thermal, 1);
  assert.equal(glow(), MILKY_WAY_INTENSITY, 'other styles keep the glow');
  f.effects.setStageIntensity(f.effects.stages.anime, 0.25);
  assert.equal(glow(), MILKY_WAY_INTENSITY * 0.75);
  f.effects.setStageIntensity(f.effects.stages.anime, 1);
  assert.equal(glow(), 0);
  f.effects.setStageIntensity(f.effects.stages.anime, 0);
  assert.equal(glow(), MILKY_WAY_INTENSITY);
  sky.destroy();
  f.effects.destroy();
});

for (const skyBox of [undefined, null, {}]) {
  test(`anime works without StarrySky (${JSON.stringify(skyBox)})`, () => {
    const f = fixture();
    f.effects.viewer.scene.skyBox = skyBox;
    f.effects.initStyles();
    f.effects.setStageIntensity(f.effects.stages.anime, 1);
    assert.equal(f.effects.stages.anime.enabled, true);
    f.effects.setStageIntensity(f.effects.stages.anime, 0);
    assert.equal(f.effects.stages.anime.enabled, false);
    if (skyBox) assert.equal('milkyWayVisibility' in skyBox, false);
    f.effects.destroy();
  });
}

test('bloom retains its dead zone, normalized intensity and independent toggle', () => {
  const f = fixture();
  f.effects.initPostProcess();
  f.effects.setBloomEnabled(true);
  f.effects.applyBloomIntensity(0);
  assert.equal(f.bloom.enabled, false);
  f.effects.applyBloomIntensity(12);
  assert.equal(f.bloom.enabled, false, 'the dead zone');
  f.effects.applyBloomIntensity(200);
  assert.equal(f.bloom.enabled, true);
  assert.equal(f.bloom.uniforms.glowOnly, false);
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
  assert.equal(f.stage('sharpen').uniforms.amount, 1.08);
  f.effects.applySharpenIntensity(1);
  f.effects.setSharpenEnabled(true);
  assert.equal(f.stage('sharpen').uniforms.amount, 2.1);
  assert.equal(f.stage('sharpen').enabled, true);
  f.effects.setSharpenEnabled(false);
  assert.equal(f.effects.sharpenIntensity, 1);
  assert.equal(f.stage('sharpen').enabled, false);
  f.effects.destroy();
});

test('sharpen at 0 runs no pass, and comes back with the slider', () => {
  const f = fixture();
  f.effects.initPostProcess(0.49);
  f.effects.setSharpenEnabled(true);
  assert.equal(f.stage('sharpen').enabled, true);
  f.effects.applySharpenIntensity(0);
  assert.equal(f.stage('sharpen').enabled, false, 'no residual sharpen at 0');
  f.effects.setSharpenEnabled(true);
  assert.equal(f.stage('sharpen').enabled, false, 'on at 0 is still off');
  f.effects.applySharpenIntensity(0.2);
  assert.equal(f.stage('sharpen').enabled, true);
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
    6,
    'Context and Cockpit may still be releasing these stages',
  );
  const intensity = f.effects.stages.retro.uniforms.intensity;
  staleFrame();
  f.effects.startTransition('retro', 0, 1);
  f.effects.setStageIntensity(f.effects.stages.retro, 1);
  assert.equal(f.frames.size, 0);
  assert.equal(f.effects.stages.retro.uniforms.intensity, intensity);
  f.effects.destroy();
  assert.equal(f.stages.size, 1, 'the styles go; sharpen is the renderer’s');
  assert.equal(f.stage('sharpen').enabled, false);
  assert.equal(f.bloom.enabled, false);
  f.effects.destroy();
  f.renderer.dispose();
  assert.equal(f.stages.size, 0);
  assert.deepEqual(
    f.bloom,
    f.originalBloom,
    'the renderer gives the bloom configuration back',
  );
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
  assert.equal(b.stages.size, 5);
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
