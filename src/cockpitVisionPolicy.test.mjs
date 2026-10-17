import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCockpitVisionStageIntensities,
  captureCockpitVisionBaseline,
  cockpitVisionModeForStyle,
  COCKPIT_VISION_MODES,
  normalizeCockpitVisionMode,
} from './cockpitVisionPolicy.js';

const createStages = () => ({
  noir: { uniforms: { intensity: 0.72, contrast: 1.3 } },
  retro: { uniforms: { intensity: 0.18, gain: 0.4 } },
  surveillance: { uniforms: { intensity: 0, grain: 0.6 } },
  thermal: { uniforms: { intensity: 0, heat: 0.8 } },
});

test('Cockpit vision order mirrors the unique map preset order', () => {
  assert.deepEqual(COCKPIT_VISION_MODES, [
    'optical',
    'crt',
    'nvg',
    'thermal',
    'anime',
    'noir',
    'snow',
  ]);
  assert.equal(normalizeCockpitVisionMode('none'), 'optical');
  assert.equal(normalizeCockpitVisionMode('unknown'), 'optical');
});

test('Cockpit entry selects the vision mode equivalent to the active map style', () => {
  assert.equal(cockpitVisionModeForStyle('normal'), 'optical');
  assert.equal(cockpitVisionModeForStyle('retro'), 'crt');
  assert.equal(cockpitVisionModeForStyle('surveillance'), 'nvg');
  assert.equal(cockpitVisionModeForStyle('thermal'), 'thermal');
  assert.equal(cockpitVisionModeForStyle('anime'), 'anime');
  assert.equal(cockpitVisionModeForStyle('noir'), 'noir');
  assert.equal(cockpitVisionModeForStyle('snow'), 'snow');
  assert.equal(cockpitVisionModeForStyle('unsupported'), 'optical');
});

test('Cockpit settles pending map crossfades before a temporary preset takes ownership', () => {
  const stages = createStages();
  const transitions = new Map([
    ['noir', { from: 0, to: 1, start: 10 }],
    ['retro', { from: 1, to: 0, start: 10 }],
  ]);
  const restore = captureCockpitVisionBaseline(stages, transitions);
  assert.deepEqual(restore, { noir: 1, retro: 0, surveillance: 0, thermal: 0 });
  assert.equal(transitions.size, 0);
  applyCockpitVisionStageIntensities(stages, 'nvg');
  assert.equal(stages.surveillance.uniforms.intensity, 1);
  applyCockpitVisionStageIntensities(stages, 'optical');
  assert.equal(stages.noir.uniforms.intensity, 0);
  assert.equal(stages.retro.uniforms.intensity, 0);
});

test('Normal clears every temporary and inherited visual stage', () => {
  const stages = createStages();
  const restore = Object.fromEntries(
    Object.entries(stages).map(([name, stage]) => [
      name,
      stage.uniforms.intensity,
    ]),
  );
  applyCockpitVisionStageIntensities(stages, 'thermal');
  applyCockpitVisionStageIntensities(stages, 'optical');
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(stages).map(([name, stage]) => [
        name,
        stage.uniforms.intensity,
      ]),
    ),
    { noir: 0, retro: 0, surveillance: 0, thermal: 0 },
  );
  assert.deepEqual(restore, {
    noir: 0.72,
    retro: 0.18,
    surveillance: 0,
    thermal: 0,
  });
});

test('temporary styles replace each other without changing the inherited restore snapshot', () => {
  const stages = createStages();
  const restore = Object.fromEntries(
    Object.entries(stages).map(([name, stage]) => [
      name,
      stage.uniforms.intensity,
    ]),
  );
  applyCockpitVisionStageIntensities(stages, 'thermal');
  assert.equal(applyCockpitVisionStageIntensities(stages, 'crt'), 'retro');
  assert.equal(stages.retro.uniforms.intensity, 1);
  assert.equal(stages.noir.uniforms.intensity, 0);
  applyCockpitVisionStageIntensities(stages, 'optical');
  assert.equal(stages.noir.uniforms.intensity, 0);
  assert.equal(stages.retro.uniforms.intensity, 0);
  assert.deepEqual(restore, {
    noir: 0.72,
    retro: 0.18,
    surveillance: 0,
    thermal: 0,
  });
});

test('NOIR is a temporary Cockpit override and Normal clears it', () => {
  const stages = createStages();
  const restore = Object.fromEntries(
    Object.entries(stages).map(([name, stage]) => [
      name,
      stage.uniforms.intensity,
    ]),
  );
  assert.equal(applyCockpitVisionStageIntensities(stages, 'noir'), 'noir');
  assert.equal(stages.noir.uniforms.intensity, 1);
  assert.equal(stages.retro.uniforms.intensity, 0);
  applyCockpitVisionStageIntensities(stages, 'optical');
  assert.equal(stages.noir.uniforms.intensity, 0);
  assert.equal(stages.retro.uniforms.intensity, 0);
  assert.deepEqual(restore, {
    noir: 0.72,
    retro: 0.18,
    surveillance: 0,
    thermal: 0,
  });
});
