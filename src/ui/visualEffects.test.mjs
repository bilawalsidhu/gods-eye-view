import assert from 'node:assert/strict';
import test from 'node:test';
import { VisualEffects } from './visualEffects.js';
import { STYLES } from './visualPresets.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { MILKY_WAY_INTENSITY, StarrySky } from '../sky/starrySky.js';
import {
  GLOBAL_POST_DEFAULTS,
  STYLE_PRESET_DEFAULTS,
  MILITARY_DETECTION_PRESET,
  ENGINE_SHARPEN_DEFAULT,
  SHARPEN_INTENSITY_DEFAULTS,
  presetSharpenIntensity,
  sharpenAmount,
} from './visualPresets.js';

function fixture(engine = null) {
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
    engine,
    viewer: {
      scene: { postProcessStages: pipeline, skyBox: { milkyWayVisibility: 1 } },
    },
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
  assert.equal(f.stages.size, 6);
  assert.ok(
    Object.values(f.effects.stages).every(
      (stage) => !stage.enabled && stage.uniforms.intensity === 0,
    ),
  );
  f.effects.initStyles();
  f.effects.initPostProcess();
  assert.equal(f.stages.size, 6);
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

test('sharpen at 0 runs no pass, and comes back with the slider', () => {
  const f = fixture();
  f.effects.initPostProcess(0.49);
  f.effects.setSharpenEnabled(true);
  assert.equal(f.effects.sharpenStage.enabled, true);
  f.effects.applySharpenIntensity(0);
  assert.equal(
    f.effects.sharpenStage.enabled,
    false,
    'no residual sharpen at 0',
  );
  f.effects.setSharpenEnabled(true);
  assert.equal(f.effects.sharpenStage.enabled, false, 'on at 0 is still off');
  f.effects.applySharpenIntensity(0.2);
  assert.equal(f.effects.sharpenStage.enabled, true);
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
  assert.equal(b.stages.size, 5);
  assert.equal(b.effects.stages.retro.uniforms.intensity, 0.5);
  b.effects.destroy();
});

test('existing baseline and military presets keep one detection default', () => {
  assert.equal(GLOBAL_POST_DEFAULTS.detectionMode, 'DENSE');
  assert.equal(GLOBAL_POST_DEFAULTS.detectionDensity, 75);
  assert.equal(
    presetSharpenIntensity(GLOBAL_POST_DEFAULTS.sharpen.intensity, 'cesium'),
    49,
  );
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

test('without a viewer the engine sharpens with the same amount scale', () => {
  const sharpen = [];
  const requests = [];
  const engine = {
    render: { setSharpen: (options) => sharpen.push(options) },
  };
  const effects = new VisualEffects({
    viewer: null,
    engine,
    requestRender: (reason) => requests.push(reason),
    holdRender() {},
    releaseRender() {},
  });
  effects.initStyles();
  effects.initPostProcess(0.49);
  assert.equal(effects.sharpenStage, null);
  effects.applySharpenIntensity(0.8);
  effects.setSharpenEnabled(true);
  effects.setSharpenEnabled(false);
  assert.deepEqual(sharpen, [
    { amount: 1.7000000000000002 },
    { enabled: true },
    { enabled: false },
  ]);
  assert.equal(sharpen[0].amount, sharpenAmount(0.8));
  assert.deepEqual(requests, ['sharpen', 'sharpen', 'sharpen']);
  effects.destroy();
});

// A fake engine drawing the app's styles (render.setStyle), as Navara does.
function styledEngine() {
  return createFakeEngine({
    kind: 'navara',
    visualStyles: Object.fromEntries(
      Object.entries(STYLES).map(([name, shader]) => [
        name,
        [
          ...Object.keys(shader.uniforms),
          ...(shader.fragmentShader.includes('uniform float time')
            ? ['time']
            : []),
        ],
      ]),
    ),
  });
}

function engineFixture(engine = styledEngine()) {
  let time = 0;
  let next = 0;
  const frames = new Map();
  const holds = new Set();
  const requests = [];
  const effects = new VisualEffects({
    viewer: null,
    engine,
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
  });
  const tick = (value) => {
    time = value;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback();
  };
  return { engine, effects, holds, requests, tick };
}

test('without a viewer an engine that draws styles gets stand-in stages', () => {
  const { engine, effects } = engineFixture();
  effects.initStyles();
  assert.deepEqual(Object.keys(effects.stages), Object.keys(STYLES));
  // Every style starts at 0 with its defaults on the engine.
  for (const name of Object.keys(STYLES)) {
    assert.equal(engine.render.style(name).intensity, 0);
    assert.equal(effects.stages[name].enabled, false);
  }
  assert.deepEqual(engine.render.style('thermal').uniforms, {
    sensitivity: 0.75,
    bloom: 0.65,
    mode: 0,
    pixelation: 1.5,
    palette: 0,
    time: 0,
  });
  // A uniform write reaches the engine, as a Cesium stage uniform would.
  effects.stages.thermal.uniforms.palette = 1;
  assert.equal(engine.render.style('thermal').uniforms.palette, 1);
  assert.equal(effects.stages.thermal.uniforms.palette, 1);
  // A value the engine refuses stays local and is reported, not thrown.
  const warn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args);
  try {
    effects.stages.noir.uniforms.grainAmt = Number.NaN;
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.equal(engine.render.style('noir').uniforms.grainAmt, 0.5);
  effects.initStyles();
  assert.equal(Object.keys(effects.stages).length, 5, 'initialised once');
  effects.destroy();
});

test('an engine crossfade eases both styles and animates time on the engine', () => {
  const { engine, effects, holds, tick } = engineFixture();
  effects.initStyles();
  effects.startTransition('thermal', 0, 1);
  tick(250);
  assert.equal(engine.render.style('thermal').intensity, 0.5);
  assert.equal(effects.stages.thermal.enabled, true);
  assert.ok(holds.has('style-anim'));
  tick(500);
  assert.equal(engine.render.style('thermal').intensity, 1);
  // The FLIR clock keeps running on the engine while the style shows.
  tick(1500);
  assert.equal(engine.render.style('thermal').uniforms.time, 1.5);
  effects.startTransition('thermal', 1, 0);
  effects.startTransition('noir', 0, 1);
  tick(1750);
  assert.equal(engine.render.style('thermal').intensity, 0.5);
  assert.equal(engine.render.style('noir').intensity, 0.5);
  tick(2000);
  tick(2016);
  assert.equal(engine.render.style('thermal').intensity, 0);
  assert.equal(engine.render.style('noir').intensity, 1);
  assert.equal(holds.has('style-anim'), false, 'noir does not animate');
  effects.destroy();
});

test('Anime on an engine without a viewer reaches no sky box', () => {
  const { engine, effects } = engineFixture();
  effects.initStyles();
  effects.setStageIntensity(effects.stages.anime, 0.7);
  assert.equal(engine.render.style('anime').intensity, 0.7);
  effects.destroy();
});

test('without a viewer an engine that blooms gets the slider strength and dead zone', () => {
  const { engine, effects, requests } = engineFixture(
    createFakeEngine({ kind: 'navara', bloom: true }),
  );
  engine.render.setBloom({ enabled: true, strength: 1 });
  effects.initPostProcess(0.49);
  assert.deepEqual(
    engine.render.bloom(),
    { enabled: false, strength: 0 },
    'a new owner starts the engine from its own bloom',
  );
  effects.applyBloomIntensity(150);
  assert.deepEqual(engine.render.bloom(), { enabled: false, strength: 0.75 });
  effects.setBloomEnabled(true);
  assert.deepEqual(engine.render.bloom(), { enabled: true, strength: 0.75 });
  // Cesium's dead zone: the toggle stays on, nothing glows.
  effects.applyBloomIntensity(10);
  assert.deepEqual(engine.render.bloom(), { enabled: false, strength: 0.05 });
  effects.applyBloomIntensity(200);
  assert.deepEqual(engine.render.bloom(), { enabled: true, strength: 1 });
  effects.setBloomEnabled(false);
  assert.equal(engine.render.bloom().enabled, false);
  assert.ok(requests.includes('bloom'));
  assert.equal(effects.bloomStage, null);
  effects.destroy();
});

test('without the visualStyles capability an engine gets no stages', () => {
  const { effects } = engineFixture(createFakeEngine({ kind: 'navara' }));
  effects.initStyles();
  assert.deepEqual(effects.stages, {});
  effects.destroy();
});

test('with a viewer the Cesium stage sharpens and the engine mirrors its state', () => {
  let state = { enabled: false, amount: 1 };
  const engine = {
    render: {
      setSharpen: (options) => {
        state = { ...state, ...options };
      },
      sharpen: () => ({ ...state }),
    },
  };
  const f = fixture(engine);
  f.effects.initPostProcess(0.49);
  assert.deepEqual(engine.render.sharpen(), {
    enabled: false,
    amount: f.effects.sharpenStage.uniforms.amount,
  });
  f.effects.applySharpenIntensity(0.8);
  f.effects.setSharpenEnabled(true);
  assert.equal(f.effects.sharpenStage.uniforms.amount, sharpenAmount(0.8));
  assert.equal(f.effects.sharpenStage.enabled, true);
  assert.deepEqual(engine.render.sharpen(), {
    enabled: true,
    amount: sharpenAmount(0.8),
  });
  f.effects.setSharpenEnabled(false);
  assert.equal(engine.render.sharpen().enabled, false);
  f.effects.destroy();
});

test('presets and the baseline take the engine default sharpen: Cesium 49 %, Navara 80 %', () => {
  assert.deepEqual(SHARPEN_INTENSITY_DEFAULTS, { cesium: 49, navara: 80 });
  for (const preset of [
    GLOBAL_POST_DEFAULTS,
    ...Object.values(STYLE_PRESET_DEFAULTS),
  ]) {
    assert.equal(preset.sharpen.intensity, ENGINE_SHARPEN_DEFAULT);
    assert.equal(
      presetSharpenIntensity(preset.sharpen.intensity, 'cesium'),
      49,
    );
    assert.equal(
      presetSharpenIntensity(preset.sharpen.intensity, 'navara'),
      80,
    );
  }
  assert.equal(presetSharpenIntensity(ENGINE_SHARPEN_DEFAULT, undefined), 49);
  // An explicit value is never remapped: 49 stays 49 on Navara.
  assert.equal(presetSharpenIntensity(49, 'navara'), 49);
  assert.equal(presetSharpenIntensity(65, 'cesium'), 65);
});
