import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNavaraLook } from './look.js';
import { navaraScenePlan } from './viewOptions.js';
import { createWorldClock } from '../../time/worldClock.js';

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

test('the sky follows world time through seek and live without moving live feeds', () => {
  let wall = Date.UTC(2026, 10, 1, 12);
  const world = createWorldClock({ now: () => wall, follow: ['sky'] });
  const view = fakeView(wall);
  const look = buildNavaraLook(view, plugin([]), navaraScenePlan('cinematic'), world.timeFor('sky'));
  const place = { lat: 30, lng: -97 };
  look.frame(900, false, 0, place, world.isLive());
  const past = wall - 6 * 3600_000;
  world.seek(past);
  look.frame(900, false, 0, place, world.isLive());
  assert.equal(view.atmosphere.date.getTime(), past);
  assert.equal(world.timeFor('flights')(), wall);
  wall += 120_000;
  look.frame(900, false, 0, place, world.isLive());
  assert.equal(view.atmosphere.date.getTime(), past, 'paused sky holds');
  assert.equal(world.timeFor('flights')(), wall);
  world.goLive();
  look.frame(900, false, 0, place, false);
  assert.equal(view.atmosphere.date.getTime(), wall);
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

test('cumulus rises over mountain terrain and leaves the orbital view clear', () => {
  const view = fakeView(0);
  const look = warmCinematic(view);
  const clouds = view.added.find(({ desc }) => Object.hasOwn(desc, 'clouds'));
  const layers = [{ altitude: 1500 }, { altitude: 1800 }];
  const pass = { cloudLayers: layers };
  clouds.ref = { raw: pass };
  assert.equal(look.frame(4350, false, 3100), true);
  assert.deepEqual(layers, [{ altitude: 6000 }, { altitude: 6300 }]);
  assert.equal(look.frame(4350, false, 3100), false);
  look.frame(8_000_000, true, 3100);
  assert.deepEqual(layers, [{ altitude: 1500 }, { altitude: 1800 }]);
  assert.deepEqual(clouds.updates, [{ visible: false }]);
  look.frame(900, false, 0);
  assert.deepEqual(clouds.updates.at(-1), { visible: true });
  look.frame(6500, true, 0);
  assert.deepEqual(clouds.updates.at(-1), { visible: true }, 'above the deck');
});

test('globe lighting switches on only at rest, and off even in motion', () => {
  const view = fakeView(0);
  const look = warmCinematic(view);
  const aerial = view.added.find(({ desc }) =>
    Object.hasOwn(desc, 'aerialPerspective'),
  );
  look.frame(20_000, true);
  look.frame(2_300_000, true);
  assert.deepEqual(aerial.updates, []);
  assert.equal(look.frame(8_000_000, false), true, 'at rest');
  assert.equal(look.frame(500_000, true), true, 'coming down');
  assert.deepEqual(aerial.updates.at(-1), {
    aerialPerspective: { irradiance: false },
  });
});

test('daylight inspection restores live exposure, tone mapping and time when left', () => {
  const view = fakeView(0);
  const look = warmCinematic(view);
  const tone = view.added.find(({ desc }) =>
    Object.hasOwn(desc, 'toneMapping'),
  );
  const aerial = view.added.find(({ desc }) =>
    Object.hasOwn(desc, 'aerialPerspective'),
  );
  const opacity = { value: 1 };
  aerial.ref = { raw: { rawEffect: { blendMode: { opacity } } } };
  const fuji = { lat: 35.2599, lng: 138.6574 };
  look.frame(6508, false, 2600, fuji, true);
  assert.equal(view.toneMappingExposure, 10);
  assert.equal(opacity.value, 1);
  assert.equal(tone.updates.at(-1).toneMapping.mode, 7);
  assert.ok(
    Math.abs(view.atmosphere.date.getTime() / 3_600_000 + fuji.lng / 15 - 13) <
      1e-6,
  );
  look.frame(750_149, false, 0, fuji, true);
  assert.ok(opacity.value < 1);
  const ambient = view.added.find(({ desc }) => Object.hasOwn(desc, 'ambient'));
  assert.equal(ambient.desc.ambient.intensity, 1);
  look.frame(6508, false, 2600, fuji, false);
  assert.equal(ambient.updates.at(-1).ambient.intensity, 0);
  assert.equal(view.toneMappingExposure, 1);
  assert.equal(opacity.value, 1);
  assert.equal(tone.updates.at(-1).toneMapping.mode, 6);
  assert.equal(view.atmosphere.date.getTime(), 0);
});

test('the dark side retains satellite imagery down to the surface', () => {
  const view = fakeView(0);
  const look = warmCinematic(view);
  const aerial = view.added.find(({ desc }) =>
    Object.hasOwn(desc, 'aerialPerspective'),
  );
  const opacity = { value: 1 };
  aerial.ref = { raw: { rawEffect: { blendMode: { opacity } } } };
  const origin = { lat: 21.975, lng: 20.9038 };
  const fuji = { lat: 35.2599, lng: 138.6574 };
  let elevation = 40;
  view.atmosphere.getSunElevation = () => elevation;
  look.frame(33_529_370, false, 0, origin, true);
  const sun = view.atmosphere.date;
  const ambient = view.added.find(({ desc }) => Object.hasOwn(desc, 'ambient'));
  elevation = -30;
  for (const height of [2_000_000, 100_000, 50_000, 6508, 600]) {
    look.frame(height, true, 0, fuji, true);
    assert.equal(opacity.value, 0.8);
    assert.equal(
      ambient.updates.length,
      0,
      'the orbital fill remains at full strength',
    );
    assert.equal(view.atmosphere.date, sun);
  }
  elevation = -3;
  look.frame(600, false, 0, fuji, true);
  assert.equal(ambient.updates.at(-1).ambient.intensity, 0.5);
  elevation = 10;
  look.frame(600, false, 0, origin, true);
  assert.equal(ambient.updates.at(-1).ambient.intensity, 0);
  assert.equal(opacity.value, 1);
});

test('inspection sunlight stays fixed through orbit, zoom and move end', () => {
  const view = fakeView(0);
  const look = warmCinematic(view);
  const origin = { lat: -45.9847, lng: 67.8795 };
  const rotated = { lat: -20, lng: -158 };
  look.frame(50_151_111, false, 0, origin, true);
  const sunDate = view.atmosphere.date;
  look.frame(50_151_111, true, 0, rotated, true);
  look.frame(750_149, false, 0, rotated, true);
  assert.equal(view.atmosphere.date, sunDate);
  look.resetDaylight();
  look.frame(750_149, false, 0, rotated, true);
  assert.notEqual(view.atmosphere.date.getTime(), sunDate.getTime());
  const restored = view.atmosphere.date;
  look.frame(50_151_111, false, 0, origin, true);
  assert.equal(view.atmosphere.date, restored);
});

test('a street map keeps the night fill after dusk, as Cesium keeps it lit', () => {
  // OSM over Austin at 12 km on the live sun: not a landscape, so the sun
  // is the wall clock's and the map has no orbital fill.
  const view = fakeView(0);
  const look = warmCinematic(view);
  const austin = { lat: 30.27, lng: -97.74 };
  let elevation = 40;
  view.atmosphere.getSunElevation = () => elevation;
  look.frame(12_000, false, 0, austin, false);
  const ambient = () =>
    view.added.find(({ desc }) => Object.hasOwn(desc, 'ambient'));
  assert.equal(ambient(), undefined, 'no fill in daylight');
  elevation = -3;
  look.frame(12_000, false, 0, austin, false);
  assert.equal(ambient().desc.ambient.intensity, 0.5, 'half at dusk');
  elevation = -40;
  look.frame(12_000, false, 0, austin, false);
  assert.equal(ambient().updates.at(-1).ambient.intensity, 1, 'full at night');
  elevation = 10;
  look.frame(12_000, false, 0, austin, false);
  assert.equal(ambient().updates.at(-1).ambient.intensity, 0, 'none by day');
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
  elevation = -8;
  assert.equal(look.frame(900, false, 0, place), true);
  assert.deepEqual(clouds.updates, [{ visible: false }]);
  elevation = -5;
  look.frame(900, false, 0, place);
  assert.deepEqual(clouds.updates, [{ visible: false }], 'hysteresis');
  assert.equal(view.atmosphere.overlay.value, null);
  look.frame(8_000_000, false, 0, place);
  assert.deepEqual(clouds.updates.at(-1), { visible: false });
  elevation = -2;
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

test('Anime fades the stars from the look own brightness and back', () => {
  const view = fakeView(0);
  const look = warmCinematic(view);
  const stars = view.added.find(({ desc }) => Object.hasOwn(desc, 'stars'));
  assert.equal(look.setStarsDimmed(0), false, 'already undimmed');
  assert.equal(look.setStarsDimmed(0.25), true);
  assert.equal(look.setStarsDimmed(0.25), false);
  assert.equal(look.setStarsDimmed(1), true);
  assert.equal(look.setStarsDimmed(0), true);
  assert.deepEqual(
    stars.updates.filter((update) => update.stars),
    [
      { stars: { intensity: 90 } },
      { stars: { intensity: 0 } },
      { stars: { intensity: 120 } },
    ],
  );
  // The minimal look keeps Navara's own intensity as its base.
  const minimalView = fakeView(0);
  const minimal = buildNavaraLook(
    minimalView,
    plugin([]),
    navaraScenePlan('minimal'),
    () => 0,
  );
  minimal.setStarsDimmed(0.5);
  const minimalStars = minimalView.added.find(({ desc }) =>
    Object.hasOwn(desc, 'stars'),
  );
  assert.deepEqual(minimalStars.updates, [{ stars: { intensity: 5 } }]);
  // A look without its own stars (the plugin's photoreal scene) ignores it.
  const photoreal = buildNavaraLook(
    fakeView(0),
    plugin([]),
    navaraScenePlan('photoreal'),
    () => 0,
  );
  assert.equal(photoreal.setStarsDimmed(1), false);
});

test('the cockpit sets the cinematic clouds cover and null gives the look its own', async () => {
  const { LOCAL_CLOUD_COVERAGE } = await import('./viewOptions.js');
  const view = fakeView(0);
  const look = warmCinematic(view);
  const clouds = view.added.find(({ desc }) => Object.hasOwn(desc, 'clouds'));
  assert.equal(look.hasClouds, true);
  assert.equal(look.setCloudCoverage(null), false, 'already the look own');
  assert.equal(look.setCloudCoverage(0.7), true);
  assert.equal(look.setCloudCoverage(0.7), false);
  assert.equal(look.setCloudCoverage(0), true);
  assert.equal(look.setCloudCoverage(null), true);
  assert.deepEqual(
    clouds.updates.filter((update) => update.clouds),
    [
      { clouds: { coverage: 0.7 } },
      { clouds: { coverage: 0 } },
      { clouds: { coverage: LOCAL_CLOUD_COVERAGE } },
    ],
  );
  // The mobile cinematic and the minimal looks draw no clouds.
  const mobile = buildNavaraLook(
    fakeView(0),
    plugin([]),
    navaraScenePlan('cinematic', { mobile: true }),
    () => 0,
  );
  assert.equal(mobile.hasClouds, false);
  assert.equal(mobile.setCloudCoverage(0.5), false);
});

test('a second look on the page scales the shared atmosphere vectors from their base, not twice', () => {
  // takram's materials hold AtmosphereParameters.DEFAULT's vectors: one
  // per page, shared by every material of every globe.
  const pageDefault = factors();
  const sharing = () => ({
    [SUN]: { value: pageDefault[SUN].value },
    [SKY]: { value: pageDefault[SKY].value },
  });
  const build = () => {
    const materials = {
      sky: sharing(),
      stars: sharing(),
      aerialPerspective: sharing(),
      clouds: sharing(),
    };
    const look = buildNavaraLook(
      fakeView(0),
      plugin([]),
      navaraScenePlan('cinematic'),
      () => 0,
      fakeInternals(materials),
    );
    look.frame(900);
    look.frame(900);
    return materials;
  };
  const first = build();
  near(first.sky[SKY].value.x, 1.5 * k);
  // The first globe's context is lost and a new one is built on the page:
  // its materials hold the vectors the first one scaled.
  const second = build();
  near(second.sky[SKY].value.x, 1.5 * k);
  near(second.clouds[SUN].value.x, 1.3 * k);
  near(pageDefault[SKY].value.x, 1.5 * k);
  assert.equal(second.stars[SKY].value.x, 1.5);
  assert.equal(second.stars[SUN].value.x, 1.3);
});

test('a value a material writes into the scaled vector is put back on the next frame', () => {
  const materials = { sky: factors(), aerialPerspective: factors() };
  const look = buildNavaraLook(
    fakeView(0),
    plugin([]),
    navaraScenePlan('cinematic'),
    () => 0,
    fakeInternals(materials),
  );
  look.frame(900);
  look.frame(900);
  // The shared scaled vector, rewritten in place to the base.
  materials.sky[SKY].value.copy(vec(1.5, 0.9, 0.8));
  assert.equal(look.frame(900), true);
  near(materials.aerialPerspective[SKY].value.x, 1.5 * k);
  assert.equal(look.frame(900), false);
});
