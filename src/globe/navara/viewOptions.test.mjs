import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_NAVARA_LOOK,
  GLOBE_LIGHTING_ENTER_M,
  GLOBE_LIGHTING_EXIT_M,
  NAVARA_CONTEXT_ATTRIBUTES,
  NAVARA_LOOKS,
  cloudTerrainOffset,
  globeLightingAt,
  navaraScenePlan,
  navaraViewOptions,
  resolveNavaraLook,
  sunDateStale,
  ATMOSPHERE_LUMINANCE_SCALE,
  STARS_HIDE_SUN_ABOVE_DEG,
  STARS_SHOW_SUN_BELOW_DEG,
  STARS_SPACE_ENTER_M,
  STARS_SPACE_EXIT_M,
  starsVisibleAt,
  CLOUDS_HIDE_SUN_BELOW_DEG,
  CLOUDS_SHOW_SUN_ABOVE_DEG,
  cloudsSunlitAt,
} from './viewOptions.js';

test('Navara renders on demand at CSS pixels without MSAA; Navara HD at the device pixel ratio with MSAA 4', () => {
  const container = { id: 'globe' };
  const canvas = { id: 'canvas' };
  assert.deepEqual(navaraViewOptions({ container, canvas }), {
    container,
    canvas,
    animation: false,
    pixelRatio: 1,
    multisampling: 0,
  });
  assert.deepEqual(navaraViewOptions({ container, canvas, hd: true }), {
    container,
    canvas,
    animation: false,
    multisampling: 4,
  });
});

test('the canvas context keeps its drawing buffer, with the attributes Navara asks for but no antialias', () => {
  assert.deepEqual(NAVARA_CONTEXT_ATTRIBUTES, {
    alpha: true,
    antialias: false,
    depth: true,
    stencil: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'default',
  });
});

test('cinematic is the default look; photoreal is the default plugin scene; minimal has no post effects', () => {
  assert.equal(DEFAULT_NAVARA_LOOK, 'cinematic');
  assert.deepEqual(navaraScenePlan(), navaraScenePlan('cinematic'));
  assert.deepEqual(navaraScenePlan('photoreal'), {
    pluginDefault: true,
    meshes: [],
    lights: [],
    effects: [],
    globeLighting: false,
    atmosphereLuminance: 1,
    daylightHidesStars: false,
  });
  assert.deepEqual(navaraScenePlan('minimal'), {
    pluginDefault: false,
    meshes: [{ sky: {} }, { stars: {} }],
    lights: [{ skyLightProbe: {} }, { sun: { castShadow: false } }],
    effects: [],
    globeLighting: false,
    atmosphereLuminance: 1,
    daylightHidesStars: false,
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
    { stars: { intensity: 120, pointSize: 2 } },
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
  assert.equal(clouds.clouds.coverage, 0.36);
  assert.equal(clouds.clouds.shadows, false, 'no cloud shadow maps');
  assert.deepEqual(
    [
      clouds.clouds.shadowMapSize.x,
      clouds.clouds.shadowMapSize.y,
      clouds.clouds.shadowCascadeCount,
    ],
    [256, 256, 2],
  );
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

test('cumulus layers rise over mountains, with sea-level bases from space', () => {
  assert.equal(cloudTerrainOffset(900, 10), 0);
  assert.equal(cloudTerrainOffset(4350, 3100), 4500);
  assert.equal(cloudTerrainOffset(4350, 3200), 4500);
  assert.equal(cloudTerrainOffset(8_000_000, 3100), 0);
  assert.equal(cloudTerrainOffset(4350, Number.NaN), 0);
});

test('the sun date is stale once it drifts a minute from the clock', () => {
  assert.equal(sunDateStale(0, 60_000), false);
  assert.equal(sunDateStale(0, 60_001), true);
  assert.equal(sunDateStale(120_000, 0), true, 'either direction');
  assert.equal(sunDateStale(Number.NaN, 0), true);
});

test('the cinematic look brightens the atmosphere, not the tiles, and hides stars by day', () => {
  const plan = navaraScenePlan('cinematic');
  assert.equal(plan.atmosphereLuminance, ATMOSPHERE_LUMINANCE_SCALE);
  assert.ok(ATMOSPHERE_LUMINANCE_SCALE > 1);
  assert.equal(plan.daylightHidesStars, true);
  for (const look of ['minimal', 'photoreal']) {
    assert.equal(navaraScenePlan(look).atmosphereLuminance, 1, look);
    assert.equal(navaraScenePlan(look).daylightHidesStars, false, look);
  }
});

test('stars show at night and from space, not in a daylit sky, with hysteresis', () => {
  assert.equal(starsVisibleAt(900, 40, true), false, 'noon');
  assert.equal(starsVisibleAt(900, 40, false), false);
  assert.equal(starsVisibleAt(900, STARS_SHOW_SUN_BELOW_DEG - 1, false), true);
  assert.equal(starsVisibleAt(900, -5, false), false, 'inside the gap');
  assert.equal(starsVisibleAt(900, -5, true), true, 'inside the gap');
  assert.equal(starsVisibleAt(900, STARS_HIDE_SUN_ABOVE_DEG + 1, true), false);
  assert.equal(starsVisibleAt(STARS_SPACE_ENTER_M, 40, false), true, 'space');
  assert.equal(starsVisibleAt(90_000, 40, true), true, 'inside the gap');
  assert.equal(starsVisibleAt(STARS_SPACE_EXIT_M - 1, 40, true), false);
  assert.equal(starsVisibleAt(900, Number.NaN, true), true, 'unknown keeps it');
  assert.equal(
    starsVisibleAt(Number.NaN, 40, false),
    false,
    'unknown keeps it',
  );
  assert.ok(STARS_SHOW_SUN_BELOW_DEG < STARS_HIDE_SUN_ABOVE_DEG);
  assert.ok(STARS_SPACE_EXIT_M < STARS_SPACE_ENTER_M);
});

test('the clouds hide once the sun sets at the camera, with hysteresis', () => {
  assert.equal(cloudsSunlitAt(40, true), true);
  assert.equal(cloudsSunlitAt(CLOUDS_HIDE_SUN_BELOW_DEG - 0.1, true), false);
  assert.equal(cloudsSunlitAt(-5, false), false, 'inside the gap');
  assert.equal(cloudsSunlitAt(-5, true), true, 'inside the gap');
  assert.equal(cloudsSunlitAt(CLOUDS_SHOW_SUN_ABOVE_DEG + 0.1, false), true);
  assert.equal(cloudsSunlitAt(Number.NaN, false), false, 'unknown keeps it');
});
