import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNavaraLook } from './look.js';
import { navaraScenePlan } from './viewOptions.js';

function fakeView(dateMs) {
  const added = [];
  const handle = (kind, desc) => {
    const entry = { kind, desc, updates: [], update: (u) => entry.updates.push(u) };
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
  const look = buildNavaraLook(view, plugin(calls), navaraScenePlan('photoreal'), () => 0);
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
  const look = buildNavaraLook(view, plugin([]), navaraScenePlan('cinematic'), () => 0);
  const effect = (name) => view.added.find(({ desc }) => Object.hasOwn(desc, name));
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
  const look = buildNavaraLook(view, plugin([]), navaraScenePlan('cinematic'), () => 0);
  const clouds = view.added.find(({ desc }) => Object.hasOwn(desc, 'clouds'));
  assert.equal(look.frame(900, true), false, 'shown at street level');
  assert.equal(look.frame(20_000, true), true);
  assert.deepEqual(clouds.updates, [{ visible: false }]);
  assert.equal(look.frame(3_800, true), false, 'hysteresis');
  assert.equal(view.atmosphere.overlay.value, null, 'no ghost of the last clouds');
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
  const look = buildNavaraLook(view, plugin([]), navaraScenePlan('cinematic'), () => 0);
  const aerial = view.added.find(({ desc }) => Object.hasOwn(desc, 'aerialPerspective'));
  look.frame(20_000, true); // the clouds hide on the way up
  assert.equal(look.frame(2_300_000, true), false, 'a flight through space');
  assert.deepEqual(aerial.updates, []);
  assert.equal(look.frame(8_000_000, false), true, 'at rest');
  assert.equal(look.frame(500_000, true), true, 'coming down');
  assert.deepEqual(aerial.updates.at(-1), { aerialPerspective: { irradiance: false } });
});

test('the sun follows the wall clock, a minute at most behind, only on drawn frames', () => {
  let now = 1_000_000;
  const view = fakeView(now);
  const look = buildNavaraLook(view, plugin([]), navaraScenePlan('photoreal'), () => now);
  now += 30_000;
  assert.equal(look.frame(900), false);
  assert.equal(view.atmosphere.date.getTime(), 1_000_000);
  now += 31_000;
  assert.equal(look.frame(900), true);
  assert.equal(view.atmosphere.date.getTime(), now);
  assert.equal(look.frame(900), false);
});
