import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNavaraLook } from './look.js';
import { navaraScenePlan } from './viewOptions.js';

function fakeView(dateMs) {
  const added = [];
  const handle = (kind, desc) => {
    const entry = {
      kind,
      desc,
      updates: [],
      update: (u) => entry.updates.push(u),
    };
    added.push(entry);
    return entry;
  };
  return {
    added,
    lit: true,
    atmosphere: {
      date: new Date(dateMs),
      overlay: { value: 'overlay' },
      shadow: { value: null },
      shadowLength: { value: 'shafts' },
    },
    addMesh: (desc) => handle('mesh', desc),
    addLight: (desc) => handle('light', desc),
    addEffect: (desc) => handle('effect', desc),
  };
}

const plugin = (calls) => ({
  addDefaultPhotorealScene: (...args) => {
    calls.push(args);
    return { sky: { id: 'sky' }, lensFlare: undefined };
  },
});

test('the photoreal look is the default plugin scene, untouched', () => {
  const calls = [];
  const view = fakeView(0);
  const look = buildNavaraLook(
    view,
    plugin(calls),
    navaraScenePlan('photoreal'),
    () => 0,
  );
  assert.deepEqual(calls, [[]]);
  assert.deepEqual(look.handles, [{ id: 'sky' }]);
  assert.equal(look.frame(8_000_000), false, 'no globe lighting');
  assert.equal(view.lit, true);
});

test('the cinematic look adds its descriptors in order', () => {
  const view = fakeView(0);
  const plan = navaraScenePlan('cinematic');
  buildNavaraLook(view, plugin([]), plan, () => 0);
  assert.deepEqual(
    view.added.map(({ kind, desc }) => [kind, desc]),
    [
      ...plan.meshes.map((desc) => ['mesh', desc]),
      ...plan.lights.map((desc) => ['light', desc]),
      ...plan.effects.map((desc) => ['effect', desc]),
    ],
  );
});

test('from space the globe is lit by the atmosphere; near the ground the tiles keep their own light', () => {
  const view = fakeView(0);
  const look = buildNavaraLook(
    view,
    plugin([]),
    navaraScenePlan('cinematic'),
    () => 0,
  );
  const effect = (name) =>
    view.added.find(({ desc }) => Object.hasOwn(desc, name));
  assert.equal(look.frame(900), false, 'nothing changes at street level');
  assert.equal(look.frame(8_000_000), true);
  assert.equal(view.lit, true, 'no tile material recompiles');
  assert.deepEqual(effect('aerialPerspective').updates, [
    { aerialPerspective: { irradiance: true } },
  ]);
  assert.equal(look.frame(7_000_000), false, 'no change while it stays up');
  assert.equal(look.frame(1_200_000), false, 'hysteresis');
  assert.equal(look.frame(500_000), true);
  assert.deepEqual(effect('aerialPerspective').updates.at(-1), {
    aerialPerspective: { irradiance: false },
  });
});

test('the clouds show only below their tops, switching in motion too', () => {
  const view = fakeView(0);
  const look = buildNavaraLook(
    view,
    plugin([]),
    navaraScenePlan('cinematic'),
    () => 0,
  );
  const clouds = view.added.find(({ desc }) => Object.hasOwn(desc, 'clouds'));
  assert.equal(look.frame(900, true), false, 'shown at street level');
  assert.equal(look.frame(20_000, true), true);
  assert.deepEqual(clouds.updates, [{ visible: false }]);
  assert.equal(look.frame(3_800, true), false, 'hysteresis');
  assert.equal(
    view.atmosphere.overlay.value,
    null,
    'no ghost of the last clouds',
  );
  assert.equal(view.atmosphere.shadowLength.value, null);
  assert.equal(look.frame(3_000, true), true);
  assert.deepEqual(clouds.updates.at(-1), { visible: true });
  assert.equal(view.atmosphere.overlay.value, 'overlay', 'put back');
  assert.equal(view.atmosphere.shadowLength.value, 'shafts');
  assert.equal(look.frame(3_000, false, 2_100), true, 'over high ground');
  assert.deepEqual(clouds.updates.at(-1), { visible: false });
});

test('globe lighting switches on only at rest, and off even in motion', () => {
  const view = fakeView(0);
  const look = buildNavaraLook(
    view,
    plugin([]),
    navaraScenePlan('cinematic'),
    () => 0,
  );
  const aerial = view.added.find(({ desc }) =>
    Object.hasOwn(desc, 'aerialPerspective'),
  );
  look.frame(20_000, true); // the clouds hide on the way up
  assert.equal(look.frame(2_300_000, true), false, 'a flight through space');
  assert.deepEqual(aerial.updates, []);
  assert.equal(look.frame(8_000_000, false), true, 'at rest');
  assert.equal(look.frame(500_000, true), true, 'coming down');
  assert.deepEqual(aerial.updates.at(-1), {
    aerialPerspective: { irradiance: false },
  });
});

test('the sun follows the wall clock, a minute at most behind, only on drawn frames', () => {
  let now = 1_000_000;
  const view = fakeView(now);
  const look = buildNavaraLook(
    view,
    plugin([]),
    navaraScenePlan('photoreal'),
    () => now,
  );
  now += 30_000;
  assert.equal(look.frame(900), false);
  assert.equal(view.atmosphere.date.getTime(), 1_000_000);
  now += 31_000;
  assert.equal(look.frame(900), true);
  assert.equal(view.atmosphere.date.getTime(), now);
  assert.equal(look.frame(900), false);
});

// A uniform as takram's materials hold it: { value: Vector3-like }.
const vec = (x, y, z) => ({
  x,
  y,
  z,
  copy(v) {
    Object.assign(this, { x: v.x, y: v.y, z: v.z });
    return this;
  },
  multiplyScalar(k) {
    this.x *= k;
    this.y *= k;
    this.z *= k;
    return this;
  },
  clone() {
    return vec(this.x, this.y, this.z);
  },
});
const luminanceUniforms = () => ({
  SUN_SPECTRAL_RADIANCE_TO_LUMINANCE: { value: vec(1.3, 0.9, 0.9) },
  SKY_SPECTRAL_RADIANCE_TO_LUMINANCE: { value: vec(1.5, 0.9, 0.8) },
});

/** Gives the cinematic handles the raw objects Navara 0.2.1 builds. */
function withRawAtmosphere(view) {
  const find = (name) =>
    view.added.find(({ desc }) => Object.hasOwn(desc, name));
  const sky = luminanceUniforms();
  const aerial = new Map(Object.entries(luminanceUniforms()));
  const clouds = luminanceUniforms();
  const stars = luminanceUniforms();
  find('sky').ref = { raw: { material: { uniforms: sky } } };
  find('stars').ref = { raw: { material: { uniforms: stars } } };
  find('aerialPerspective').ref = { raw: { rawEffect: { uniforms: aerial } } };
  find('clouds').ref = {
    raw: {
      rawEffect: { cloudsPass: { currentMaterial: { uniforms: clouds } } },
    },
  };
  return { sky, aerial, clouds, stars };
}

test('the cinematic atmosphere is brighter, the stars and tiles are not', () => {
  const view = fakeView(0);
  const plan = navaraScenePlan('cinematic');
  const look = buildNavaraLook(view, plugin([]), plan, () => 0);
  const raw = withRawAtmosphere(view);
  assert.equal(look.frame(900), true, 'the first frame applies the scale');
  const k = plan.atmosphereLuminance;
  const sky = (u) => u.SKY_SPECTRAL_RADIANCE_TO_LUMINANCE.value;
  const sun = (u) => u.SUN_SPECTRAL_RADIANCE_TO_LUMINANCE.value;
  assert.ok(Math.abs(sky(raw.sky).x - 1.5 * k) < 1e-12);
  assert.ok(Math.abs(sun(raw.sky).x - 1.3 * k) < 1e-12);
  assert.ok(
    Math.abs(
      raw.aerial.get('SKY_SPECTRAL_RADIANCE_TO_LUMINANCE').value.x - 1.5 * k,
    ) < 1e-12,
  );
  assert.ok(Math.abs(sky(raw.clouds).z - 0.8 * k) < 1e-12);
  assert.equal(
    sky(raw.stars).x,
    1.5,
    'only the sky, aerial perspective and clouds are walked',
  );
  assert.equal(look.frame(900), false, 'applied once, not compounded');
  assert.ok(Math.abs(sky(raw.sky).x - 1.5 * k) < 1e-12);
  // Navara rebuilds a material (a cloud quality change): the new one is scaled.
  const fresh = luminanceUniforms();
  view.added.find(({ desc }) =>
    Object.hasOwn(desc, 'clouds'),
  ).ref.raw.rawEffect.cloudsPass.currentMaterial = { uniforms: fresh };
  assert.equal(look.frame(900), true);
  assert.ok(Math.abs(sky(fresh).x - 1.5 * k) < 1e-12);
});

test('a look without the scale and an atmosphere not built yet are left alone', () => {
  const view = fakeView(0);
  const look = buildNavaraLook(
    view,
    plugin([]),
    navaraScenePlan('minimal'),
    () => 0,
  );
  const sky = luminanceUniforms();
  view.added[0].ref = { raw: { material: { uniforms: sky } } };
  assert.equal(look.frame(900), false);
  assert.equal(sky.SKY_SPECTRAL_RADIANCE_TO_LUMINANCE.value.x, 1.5);
  const cinematic = fakeView(0);
  const other = buildNavaraLook(
    cinematic,
    plugin([]),
    navaraScenePlan('cinematic'),
    () => 0,
  );
  assert.equal(other.frame(900), false, 'no raw objects yet: nothing to scale');
});

test('the cinematic stars hide in a daylit sky and show at night and from space', () => {
  const view = fakeView(0);
  let elevation = 40;
  view.atmosphere.getSunElevation = () => elevation;
  const look = buildNavaraLook(
    view,
    plugin([]),
    navaraScenePlan('cinematic'),
    () => 0,
  );
  const stars = view.added.find(({ desc }) => Object.hasOwn(desc, 'stars'));
  const place = { lat: 40.7, lng: -74 };
  assert.equal(look.frame(900, false, 0, place), true);
  assert.deepEqual(stars.updates, [{ visible: false }]);
  assert.equal(look.frame(900, false, 0, place), false);
  elevation = -10;
  assert.equal(look.frame(900, false, 0, place), true);
  assert.deepEqual(stars.updates.at(-1), { visible: true });
  elevation = 40;
  look.frame(900, false, 0, place);
  assert.equal(look.frame(8_000_000, false, 0, place), true, 'from space');
  assert.deepEqual(stars.updates.at(-1), { visible: true });
  const count = stars.updates.length;
  look.frame(900, false, 0);
  assert.equal(stars.updates.length, count, 'no place keeps them');
  assert.equal(look.frame(900, false, 0, place), true, 'back down by day');
  assert.deepEqual(stars.updates.at(-1), { visible: false });
});

test('the minimal look keeps its stars whatever the sun', () => {
  const view = fakeView(0);
  view.atmosphere.getSunElevation = () => 40;
  const look = buildNavaraLook(
    view,
    plugin([]),
    navaraScenePlan('minimal'),
    () => 0,
  );
  look.frame(900, false, 0, { lat: 0, lng: 0 });
  assert.deepEqual(view.added[1].updates, []);
});

test('a factor vector the materials share is scaled once', () => {
  const view = fakeView(0);
  const plan = navaraScenePlan('cinematic');
  const look = buildNavaraLook(view, plugin([]), plan, () => 0);
  const shared = luminanceUniforms();
  const find = (name) =>
    view.added.find(({ desc }) => Object.hasOwn(desc, name));
  find('sky').ref = { raw: { material: { uniforms: shared } } };
  find('aerialPerspective').ref = {
    raw: { rawEffect: { uniforms: new Map(Object.entries(shared)) } },
  };
  find('clouds').ref = {
    raw: {
      rawEffect: {
        cloudsPass: { currentMaterial: { uniforms: { ...shared } } },
      },
    },
  };
  look.frame(900);
  look.frame(900);
  assert.ok(
    Math.abs(
      shared.SKY_SPECTRAL_RADIANCE_TO_LUMINANCE.value.x -
        1.5 * plan.atmosphereLuminance,
    ) < 1e-12,
  );
});
