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

/** A cinematic look past its two warm-up frames (updates cleared). */
function warmCinematic(view, internals) {
  const look = buildNavaraLook(
    view,
    plugin([]),
    navaraScenePlan('cinematic'),
    () => 0,
    internals,
  );
  look.frame(900);
  look.frame(900);
  for (const entry of view.added) entry.updates.length = 0;
  return look;
}

test('the night-side shader variants are both compiled on the first two frames', () => {
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
  assert.equal(look.frame(900), true);
  assert.equal(look.frame(900), true);
  assert.deepEqual(aerial.updates, [
    { aerialPerspective: { irradiance: true } },
    { aerialPerspective: { irradiance: false } },
  ]);
  assert.equal(look.frame(900), false, 'then the usual rules');
  const minimal = fakeView(0);
  const plain = buildNavaraLook(
    minimal,
    plugin([]),
    navaraScenePlan('minimal'),
    () => 0,
  );
  assert.equal(plain.frame(900), false, 'no aerial perspective: no warm-up');
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
  const look = warmCinematic(view);
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
  const look = warmCinematic(view);
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
  const look = warmCinematic(view);
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
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
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
  equals(v) {
    return v.x === this.x && v.y === this.y && v.z === this.z;
  },
});
const SUN = 'SUN_SPECTRAL_RADIANCE_TO_LUMINANCE';
const SKY = 'SKY_SPECTRAL_RADIANCE_TO_LUMINANCE';
const factors = () => ({
  [SUN]: { value: vec(1.3, 0.9, 0.9) },
  [SKY]: { value: vec(1.5, 0.9, 0.8) },
});

/** A stand-in for internals.js forEachLuminanceUniform over fake materials. */
function fakeInternals(materials) {
  return {
    forEachLuminanceUniform(handles, visit) {
      for (const [name, scaled] of [
        ['sky', true],
        ['stars', false],
        ['aerialPerspective', true],
        ['clouds', true],
      ]) {
        if (!handles[name]) continue;
        const uniforms = materials[name];
        if (!uniforms) continue;
        for (const key of [SUN, SKY]) visit(key, uniforms[key], scaled);
      }
    },
  };
}

const k = navaraScenePlan('cinematic').atmosphereLuminance;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);

test('the atmosphere factors are set to scale × base, never compounded', () => {
  const materials = {
    sky: factors(),
    stars: factors(),
    aerialPerspective: factors(),
    clouds: factors(),
  };
  const view = fakeView(0);
  const look = buildNavaraLook(
    view,
    plugin([]),
    navaraScenePlan('cinematic'),
    () => 0,
    fakeInternals(materials),
  );
  look.frame(900);
  near(materials.sky[SKY].value.x, 1.5 * k);
  near(materials.sky[SUN].value.x, 1.3 * k);
  near(materials.aerialPerspective[SKY].value.z, 0.8 * k);
  near(materials.clouds[SKY].value.x, 1.5 * k);
  assert.equal(materials.stars[SKY].value.x, 1.5, 'the stars keep the base');
  look.frame(900);
  look.frame(900);
  assert.equal(look.frame(900), false, 'nothing to change once applied');
  near(materials.sky[SKY].value.x, 1.5 * k);
  // A rebuilt material copying the scaled vector is not scaled again.
  materials.clouds = {
    [SUN]: { value: materials.sky[SUN].value.clone() },
    [SKY]: { value: materials.sky[SKY].value.clone() },
  };
  assert.equal(look.frame(900), false);
  near(materials.clouds[SKY].value.x, 1.5 * k);
  // One built from scratch is.
  materials.clouds = factors();
  assert.equal(look.frame(900), true);
  near(materials.clouds[SKY].value.x, 1.5 * k);
});

test('vectors shared between materials are scaled once; stars sharing them get their own', () => {
  // Separate uniforms holding one vector each, as Navara 0.2.1 builds them.
  const shared = factors();
  const sharing = () => ({
    [SUN]: { value: shared[SUN].value },
    [SKY]: { value: shared[SKY].value },
  });
  const materials = {
    sky: shared,
    stars: sharing(),
    aerialPerspective: sharing(),
    clouds: sharing(),
  };
  const view = fakeView(0);
  const look = buildNavaraLook(
    view,
    plugin([]),
    navaraScenePlan('cinematic'),
    () => 0,
    fakeInternals(materials),
  );
  look.frame(900);
  look.frame(900);
  near(shared[SKY].value.x, 1.5 * k);
  assert.notEqual(materials.stars[SKY].value, shared[SKY].value);
  assert.equal(materials.stars[SKY].value.x, 1.5);
  assert.equal(materials.stars[SUN].value.x, 1.3);
});

test('a look without the scale, or without internals, leaves the factors alone', () => {
  const materials = { sky: factors(), stars: factors() };
  const view = fakeView(0);
  const look = buildNavaraLook(
    view,
    plugin([]),
    navaraScenePlan('minimal'),
    () => 0,
    fakeInternals(materials),
  );
  assert.equal(look.frame(900), false);
  assert.equal(materials.sky[SKY].value.x, 1.5);
  const other = fakeView(0);
  const cinematic = buildNavaraLook(
    other,
    plugin([]),
    navaraScenePlan('cinematic'),
    () => 0,
  );
  cinematic.frame(900);
  cinematic.frame(900);
  assert.equal(cinematic.frame(900), false, 'no internals: no scale');
});

test('the cinematic stars hide in a daylit sky and show at night and from space', () => {
  const view = fakeView(0);
  let elevation = 40;
  view.atmosphere.getSunElevation = () => elevation;
  const look = warmCinematic(view);
  const stars = view.added.find(({ desc }) => Object.hasOwn(desc, 'stars'));
  const place = { lat: 40.7, lng: -74 };
  assert.equal(look.frame(900, false, 0, place), true);
  assert.deepEqual(stars.updates, [{ visible: false }]);
  assert.equal(look.frame(900, false, 0, place), false);
  elevation = -10;
  look.frame(900, false, 0, place);
  assert.deepEqual(stars.updates.at(-1), { visible: true });
  elevation = 40;
  look.frame(900, false, 0, place);
  assert.equal(look.frame(8_000_000, false, 0, place), true, 'from space');
  assert.deepEqual(stars.updates.at(-1), { visible: true });
  const count = stars.updates.length;
  look.frame(900, false, 0);
  assert.equal(stars.updates.length, count, 'no place keeps them');
  look.frame(900, false, 0, place);
  assert.deepEqual(stars.updates.at(-1), { visible: false });
});

test('the cinematic clouds hide after sunset at the camera', () => {
  const view = fakeView(0);
  let elevation = 20;
  view.atmosphere.getSunElevation = () => elevation;
  const look = warmCinematic(view);
  const clouds = view.added.find(({ desc }) => Object.hasOwn(desc, 'clouds'));
  const place = { lat: 40.7, lng: -74 };
  assert.equal(look.frame(900, false, 0, place), true, 'the stars hide');
  assert.deepEqual(clouds.updates, []);
  elevation = -1;
  assert.equal(look.frame(900, false, 0, place), true);
  assert.deepEqual(clouds.updates, [{ visible: false }]);
  elevation = 1;
  look.frame(900, false, 0, place);
  assert.deepEqual(clouds.updates, [{ visible: false }], 'hysteresis');
  elevation = 3;
  look.frame(900, false, 0, place);
  assert.deepEqual(clouds.updates.at(-1), { visible: true });
});

test('the minimal look keeps its stars and clouds whatever the sun', () => {
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
