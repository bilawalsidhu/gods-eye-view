import assert from 'node:assert/strict';
import test from 'node:test';
import { cartesian3, cartographic } from '../../../geo/index.js';
import { createFakeEngine } from '../fakeEngine.js';
import { fakeContractOptions } from '../contractFixtures.js';
import { createContractSuite } from './index.mjs';

for (const [scenario, failure] of [
  ['visible surface and underground, occluded horizon', null],
  ['surface buried', /normal point visible on its supporting surface/],
  ['underground hidden', /normal point visible below terrain/],
  ['depth bypass', /normal point behind the horizon is visible/],
  ['missing control', /surface control drawn/],
  ['missing height', /surface points placed/],
]) {
  test(`surface mover check: ${scenario}`, async () => {
    const engine = createFakeEngine();
    engine.fake.script('terrainHeight', () =>
      scenario === 'missing height' ? undefined : 400,
    );
    const listeners = engine.frames.preRender.numberOfListeners;
    const states = [];
    const createSet = engine.movers.createSet.bind(engine.movers);
    engine.movers.createSet = (options) => {
      const set = createSet(options);
      const state = { set, depthTest: options.depthTest };
      states.push(state);
      const write = set.set.bind(set);
      set.set = (index, fields) => {
        if (fields.position) state.position = fields.position;
        return write(index, fields);
      };
      return set;
    };
    let surfaceRead = false;
    let buriedRead = false;
    let horizonRead = false;
    const check = createContractSuite(engine, {
      ...fakeContractOptions(engine),
      maxWaitFrames: 4,
      readRegion: (_x, _y, width, height) => {
        const shown = states.filter(({ set }) => set.count() === 1);
        assert.equal(shown.length, 1, 'one depth mode at a time');
        const state = shown[0];
        const place = cartographic.fromCartesian(state.position);
        const below = place.height < -100;
        const farSide = place.longitude < 0;
        const normal = state.depthTest === 'normal';
        surfaceRead ||= normal && !below && !farSide;
        horizonRead ||= normal && farSide;
        buriedRead ||= normal && below;
        let count = 400;
        if (scenario === 'missing control') count = 0;
        else if (normal && farSide && scenario !== 'depth bypass') count = 0;
        else if (normal && below && scenario === 'underground hidden')
          count = 0;
        else if (normal && !below && scenario === 'surface buried') count = 20;
        const data = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < count; i++) data.set([255, 0, 255, 255], i * 4);
        return data;
      },
    }).find(({ name }) => name.startsWith('movers.createSet: sampled surface'));
    try {
      assert.ok(check, 'surface mover regression is in the contract suite');
      if (failure) await assert.rejects(check.run(), failure);
      else {
        await check.run();
        assert.ok(surfaceRead && buriedRead && horizonRead);
      }
      assert.deepEqual(engine.movers.list(), []);
      assert.equal(engine.frames.preRender.numberOfListeners, listeners);
    } finally {
      engine.destroy();
    }
  });
}

for (const [scenario, failure] of [
  ['occluded', null],
  ['depth bypass', /normal point behind a tiles mesh is visible/],
  ['missing control', /tile control drawn/],
  ['missing tile', /tile occluder loaded/],
]) {
  test(`tiles mover check: ${scenario}`, async () => {
    const engine = createFakeEngine();
    engine.fake.script('sampleHeightDetailed', () =>
      scenario === 'missing tile'
        ? undefined
        : { source: 'tiles', height: 200, tileSizeM: 100 },
    );
    const options = fakeContractOptions(engine);
    const check = createContractSuite(engine, {
      ...options,
      fixtures: {
        ...options.fixtures,
        tiles: { position: cartesian3.fromDegrees(20, 10, 200) },
      },
      maxWaitFrames: 4,
      readRegion: (_x, _y, width, height) => {
        const normal =
          engine.fake.moverSet('contract-tile-point-normal').store.count === 1;
        const count =
          scenario === 'missing control' ||
          (normal && scenario !== 'depth bypass')
            ? 0
            : 400;
        const data = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < count; i++) data.set([255, 0, 255, 255], i * 4);
        return data;
      },
    }).find(({ name }) => name.includes('behind a tiles mesh'));
    try {
      assert.ok(
        check,
        'tiles check is registered when the fixture is supplied',
      );
      if (failure) await assert.rejects(check.run(), failure);
      else await check.run();
      assert.deepEqual(engine.movers.list(), []);
      assert.equal(engine.camera.following(), null);
    } finally {
      engine.destroy();
    }
  });
}

test('fake normal movers remain pickable below nearby terrain and disappear behind the horizon', () => {
  const engine = createFakeEngine();
  engine.fake.script('terrainHeight', () => 400);
  engine.camera.setView({
    destination: cartesian3.fromDegrees(20, 10, 10000),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
  const set = engine.movers.createSet({
    id: 'terrain-depth',
    kind: 'point',
    capacity: 1,
    depthTest: 'normal',
    point: { sizePx: 24 },
    pickable: true,
  });
  try {
    for (const [position, visible] of [
      [cartesian3.fromDegrees(20, 10, 400), true],
      [cartesian3.fromDegrees(20, 10, -600), true],
      [cartesian3.fromDegrees(-160, -10), false],
    ]) {
      set.set(0, { position, pickId: 'marker' });
      set.setCount(1);
      set.commit();
      const screen = engine.projector.worldToWindow(position);
      assert.equal(engine.picker.pick(screen)?.id === 'marker', visible);
    }
  } finally {
    engine.destroy();
  }
});
