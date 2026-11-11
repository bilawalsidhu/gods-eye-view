import test from 'node:test';
import assert from 'node:assert/strict';
import { bloomUniforms, createCesiumPostStages } from './postStages.js';

function setup() {
  const stages = [];
  const requests = [];
  const bloom = {
    enabled: false,
    uniforms: {
      glowOnly: true,
      contrast: 128,
      brightness: -0.3,
      delta: 1,
      sigma: 3.78,
      stepSize: 5,
    },
  };
  const original = structuredClone(bloom);
  const scene = {
    skyBox: { milkyWayVisibility: 1 },
    postProcessStages: {
      bloom,
      add: (stage) => stages.push(stage),
      remove: (stage) => {
        const index = stages.indexOf(stage);
        if (index >= 0) stages.splice(index, 1);
        return index >= 0;
      },
    },
  };
  const effects = createCesiumPostStages(
    { scene },
    {
      requestRender: (reason) => requests.push(reason),
      createStage: (options) => ({ ...options, enabled: true }),
    },
  );
  const stage = (name) =>
    stages.find((entry) => entry.name === `godsEyeView_${name}`);
  return {
    effects,
    render: effects.render,
    scene,
    stages,
    stage,
    requests,
    bloom,
    original,
  };
}

test('creation adds nothing; the first style or sharpen call adds all six, in draw order', () => {
  const { render, stages } = setup();
  assert.deepEqual(render.visualStyles, [
    'retro',
    'surveillance',
    'thermal',
    'anime',
    'noir',
  ]);
  render.bloom();
  render.style('thermal');
  assert.equal(stages.length, 0);
  render.setSharpen({ amount: 1.5 });
  assert.deepEqual(
    stages.map(({ name }) => name),
    [
      'godsEyeView_retro',
      'godsEyeView_surveillance',
      'godsEyeView_thermal',
      'godsEyeView_anime',
      'godsEyeView_noir',
      'godsEyeView_sharpen',
    ],
  );
  assert.ok(stages.every((stage) => !stage.enabled));
  render.setStyle('noir', { intensity: 0.5 });
  assert.equal(stages.length, 6);
});

test('a style draws above 0.001 with its uniforms; style() is a copy; unknown names throw', () => {
  const { render, stage, requests } = setup();
  assert.deepEqual(render.style('thermal'), {
    intensity: 0,
    uniforms: {
      time: 0,
      sensitivity: 0.75,
      bloom: 0.65,
      mode: 0,
      pixelation: 1.5,
      palette: 0,
    },
  });
  render.setStyle('thermal', { intensity: 0.0005 });
  assert.equal(stage('thermal').enabled, false);
  render.setStyle('thermal', { intensity: 1, uniforms: { palette: 1 } });
  assert.equal(stage('thermal').enabled, true);
  assert.equal(stage('thermal').uniforms.intensity, 1);
  assert.equal(stage('thermal').uniforms.palette, 1);
  render.style('thermal').uniforms.palette = 0;
  assert.equal(render.style('thermal').uniforms.palette, 1);
  assert.ok(requests.includes('style-stage'));
  assert.throws(() => render.setStyle('sepia', {}), TypeError);
  assert.throws(
    () => render.setStyle('noir', { uniforms: { palette: 1 } }),
    TypeError,
  );
  assert.throws(() => render.setStyle('noir', { intensity: 2 }), TypeError);
});

test('Anime fades the Milky Way with its intensity; a sky without one is left alone', () => {
  const { render, scene } = setup();
  render.setStyle('anime', { intensity: 0.25 });
  assert.equal(scene.skyBox.milkyWayVisibility, 0.75);
  render.setStyle('thermal', { intensity: 1 });
  assert.equal(scene.skyBox.milkyWayVisibility, 0.75);
  render.setStyle('anime', { intensity: 0 });
  assert.equal(scene.skyBox.milkyWayVisibility, 1);
  scene.skyBox = {};
  render.setStyle('anime', { intensity: 1 });
  assert.equal('milkyWayVisibility' in scene.skyBox, false);
});

test('bloom eases the strength above its dead zone and gives the stage back on destroy', () => {
  const { effects, render, bloom, original, stages } = setup();
  render.setBloom({ enabled: true, strength: 0.05 });
  assert.equal(bloom.enabled, false, 'the dead zone glows nothing');
  assert.equal(bloom.uniforms.glowOnly, false);
  render.setBloom({ strength: 1 });
  assert.equal(bloom.enabled, true);
  assert.deepEqual(bloom.uniforms, {
    glowOnly: false,
    ...bloomUniforms(1),
  });
  assert.equal(bloom.uniforms.contrast, 87);
  render.setBloom({ enabled: false });
  assert.equal(bloom.enabled, false);
  assert.deepEqual(render.bloom(), { enabled: false, strength: 1 });
  render.setSharpen({ enabled: true });
  effects.destroy();
  effects.destroy();
  assert.equal(stages.length, 0);
  assert.deepEqual(bloom, original);
  // Later calls keep the state only.
  render.setStyle('noir', { intensity: 1 });
  assert.equal(stages.length, 0);
  assert.equal(render.style('noir').intensity, 1);
});
