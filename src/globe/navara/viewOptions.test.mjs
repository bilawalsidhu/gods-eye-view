import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_NAVARA_LOOK,
  GLOBE_LIGHTING_ENTER_M,
  GLOBE_LIGHTING_EXIT_M,
  NAVARA_CONTEXT_ATTRIBUTES,
  NAVARA_LOOKS,
  CLOUDS_HIDE_ABOVE_M,
  CLOUDS_HIDE_OVER_GROUND_M,
  CLOUDS_SHOW_BELOW_M,
  CLOUDS_SHOW_OVER_GROUND_M,
  cloudsVisibleAt,
  globeLightingAt,
  navaraScenePlan,
  navaraViewOptions,
  resolveNavaraLook,
  sunDateStale,
} from './viewOptions.js';

test('the product view renders on demand with MSAA 4 at the native pixel ratio', () => {
  const container = { id: 'globe' };
  const canvas = { id: 'canvas' };
  assert.deepEqual(navaraViewOptions({ container, canvas }), {
    container,
    canvas,
    animation: false,
    multisampling: 4,
  });
  assert.equal(
    navaraViewOptions({ container, pixelRatio: 1 }).pixelRatio,
    1,
    'measurements pin the pixel ratio',
  );
});

test('the canvas context keeps its drawing buffer, with the attributes Navara asks for', () => {
  assert.deepEqual(NAVARA_CONTEXT_ATTRIBUTES, {
    alpha: true,
    antialias: true,
    depth: true,
    stencil: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'default',
  });
});

test('cinematic is the default look; photoreal is the default plugin scene; minimal has no post effects (S5)', () => {
  assert.equal(DEFAULT_NAVARA_LOOK, 'cinematic');
  assert.deepEqual(navaraScenePlan(), navaraScenePlan('cinematic'));
  assert.deepEqual(navaraScenePlan('photoreal'), {
    pluginDefault: true,
    meshes: [],
    lights: [],
    effects: [],
    globeLighting: false,
  });
  assert.deepEqual(navaraScenePlan('minimal'), {
    pluginDefault: false,
    meshes: [{ sky: {} }, { stars: {} }],
    lights: [{ skyLightProbe: {} }, { sun: {} }],
    effects: [],
    globeLighting: false,
  });
  assert.throws(() => navaraScenePlan('cine'), RangeError);
  assert.throws(() => navaraScenePlan('toString'), RangeError);
});

const names = (descs) => descs.map((desc) => Object.keys(desc)[0]);

test('the cinematic look: photoreal plus clouds and ACES, no sun shadow maps, no relighting of the tiles', () => {
  const plan = navaraScenePlan('cinematic');
  assert.equal(plan.pluginDefault, false);
  assert.deepEqual(plan.meshes, [
    { sky: {} },
    { stars: { intensity: 40, pointSize: 2 } },
  ]);
  assert.deepEqual(plan.lights, [
    { skyLightProbe: {} },
    { sun: { castShadow: false } },
  ]);
  assert.deepEqual(names(plan.effects), [
    'aerialPerspective',
    'clouds',
    'lensFlare',
    'toneMapping',
    'smaa',
  ]);
  const [aerial, clouds, , toneMapping] = plan.effects;
  // Forward lighting up close: no irradiance, shadow or specular terms.
  assert.deepEqual(aerial.aerialPerspective, {
    useNormalBuffer: false,
    albedoScale: 2,
  });
  assert.equal(clouds.clouds.coverage, 0.2);
  assert.equal(clouds.clouds.shadows, false, 'no cloud shadow maps');
  assert.ok(
    clouds.clouds.cloudLayers.every(({ altitude }) => altitude >= 1000),
    'cloud layers sit above the city views',
  );
  assert.equal(toneMapping.toneMapping.mode, 6, 'ACES filmic');
  assert.equal(plan.globeLighting, true);
  // Legibility: none of the effects that blur, rain on or grey the map.
  for (const rejected of ['depthOfField', 'rainDrop', 'ssao', 'ssr'])
    assert.ok(!names(plan.effects).includes(rejected), rejected);
});

test('a mobile-optimized view drops clouds and lens flare and uses FXAA', () => {
  assert.deepEqual(
    names(navaraScenePlan('cinematic', { mobile: true }).effects),
    ['aerialPerspective', 'toneMapping', 'fxaa'],
  );
});

test('each call returns a fresh plan', () => {
  const plan = navaraScenePlan('cinematic');
  plan.effects.length = 0;
  assert.equal(navaraScenePlan('cinematic').effects.length, 5);
});

test('?look= picks a look, anything else the cinematic default', () => {
  assert.deepEqual(NAVARA_LOOKS, ['minimal', 'photoreal', 'cinematic']);
  assert.equal(resolveNavaraLook(''), 'cinematic');
  assert.equal(resolveNavaraLook('?engine=navara'), 'cinematic');
  assert.equal(resolveNavaraLook('?engine=navara&look=photoreal'), 'photoreal');
  assert.equal(resolveNavaraLook('?look=%20Minimal%20'), 'minimal');
  assert.equal(resolveNavaraLook('?look=rain'), 'cinematic');
  assert.equal(resolveNavaraLook('?look=constructor'), 'cinematic');
});

test('globe lighting turns on from space and off near the ground, with hysteresis', () => {
  assert.equal(globeLightingAt(GLOBE_LIGHTING_ENTER_M - 1, false), false);
  assert.equal(globeLightingAt(GLOBE_LIGHTING_ENTER_M, false), true);
  assert.equal(globeLightingAt(8_000_000, false), true);
  assert.equal(globeLightingAt(1_200_000, true), true, 'inside the gap');
  assert.equal(globeLightingAt(1_200_000, false), false, 'inside the gap');
  assert.equal(globeLightingAt(GLOBE_LIGHTING_EXIT_M, true), false);
  assert.equal(globeLightingAt(900, true), false);
  assert.equal(globeLightingAt(Number.NaN, true), true, 'unknown keeps it');
  assert.ok(GLOBE_LIGHTING_EXIT_M < GLOBE_LIGHTING_ENTER_M);
});

test('the clouds show for low views over low ground, with hysteresis', () => {
  assert.equal(cloudsVisibleAt(900, 10, true), true);
  assert.equal(cloudsVisibleAt(900, Number.NaN, true), true, 'unknown ground');
  assert.equal(cloudsVisibleAt(CLOUDS_HIDE_ABOVE_M, 0, true), true);
  assert.equal(cloudsVisibleAt(CLOUDS_HIDE_ABOVE_M + 1, 0, true), false);
  assert.equal(cloudsVisibleAt(3_800, 0, false), false, 'inside the gap');
  assert.equal(cloudsVisibleAt(CLOUDS_SHOW_BELOW_M - 1, 0, false), true);
  assert.equal(cloudsVisibleAt(3_000, 2_100, true), false, 'over a canyon rim');
  assert.equal(cloudsVisibleAt(3_000, 900, false), false, 'inside the gap');
  assert.equal(
    cloudsVisibleAt(3_000, CLOUDS_SHOW_OVER_GROUND_M - 1, false),
    true,
  );
  assert.equal(cloudsVisibleAt(CLOUDS_HIDE_OVER_GROUND_M, 0, true), true);
  assert.equal(
    cloudsVisibleAt(Number.NaN, 0, false),
    false,
    'unknown keeps it',
  );
  const layers = navaraScenePlan('cinematic').effects[1].clouds.cloudLayers;
  assert.ok(
    layers[0].altitude - CLOUDS_HIDE_OVER_GROUND_M >= 500,
    'cloud base well above the highest ground they show over',
  );
});

test('the sun date is stale once it drifts a minute from the clock', () => {
  assert.equal(sunDateStale(0, 60_000), false);
  assert.equal(sunDateStale(0, 60_001), true);
  assert.equal(sunDateStale(120_000, 0), true, 'either direction');
  assert.equal(sunDateStale(Number.NaN, 0), true);
});
