import { fakeContractOptions } from './contractFixtures.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createEngineEvent, engineContractMembers } from '../contract.js';
import { contractCallMembers, withCallLog } from './callLog.js';
import { createContractSuite } from './contractSuite.mjs';
import { createFakeEngine } from './fakeEngine.js';

test('the contract suite does not leave new members uncalled', async (t) => {
  const fake = createFakeEngine();
  const { engine, called } = withCallLog(fake);
  const checks = createContractSuite(engine, {
    ...fakeContractOptions(engine),
    pointer: {
      ...fakeContractOptions(engine).pointer,
      click: async (x, y) => fake.fake.input('click', { position: { x, y } }),
      move: async (x, y) =>
        fake.fake.input('move', {
          startPosition: { x: x - 1, y },
          endPosition: { x, y },
        }),
    },
    mapSources: {
      imagery: [{ kind: 'osm' }, { kind: 'esri-imagery' }],
      photoreal: { kind: 'photoreal' },
    },
  });
  try {
    for (const check of checks) await t.test(check.name, () => check.run());
    const baseline = JSON.parse(
      fs.readFileSync(
        new URL('./contract-uncalled-baseline.json', import.meta.url),
        'utf8',
      ),
    );
    const seen = new Set(called());
    const uncalled = contractCallMembers().filter((name) => !seen.has(name));
    assert.deepEqual(
      baseline,
      [...new Set(baseline)].sort(),
      'Keep contract-uncalled-baseline.json sorted and remove duplicate names.',
    );
    assert.deepEqual(
      uncalled.filter((name) => !baseline.includes(name)),
      [],
      'Contract members lost coverage; add behavioral checks to createContractSuite that exercise them instead of growing contract-uncalled-baseline.json.',
    );
    assert.deepEqual(
      baseline.filter((name) => !uncalled.includes(name)),
      [],
      'Contract members are now exercised or no longer exist; remove these names from contract-uncalled-baseline.json to lower the baseline.',
    );
  } finally {
    fake.destroy();
  }
});

test('call logging keeps receivers, arguments, results and function identity', async () => {
  const result = { height: 5 };
  const promise = Promise.resolve(result);
  const camera = {
    flyTo(destination) {
      assert.equal(this, camera);
      return destination;
    },
  };
  const maps = {
    setTerrain() {
      assert.equal(this, maps);
      return promise;
    },
  };
  const { engine, called } = withCallLog({ camera, maps });
  const flyTo = engine.camera.flyTo;
  assert.equal(flyTo, engine.camera.flyTo);
  assert.deepEqual(called(), [], 'shape inspection must not count as a call');
  assert.equal(flyTo(result), result);
  assert.equal(engine.maps.setTerrain(), promise);
  assert.equal(await promise, result);
  assert.deepEqual(called(), ['camera.flyTo', 'maps.setTerrain']);
  called().push('not a member');
  assert.deepEqual(called(), ['camera.flyTo', 'maps.setTerrain']);
});

test('returned handles log under their contract type and retain receivers', () => {
  const handle = {
    set() {
      assert.equal(this, handle);
      return 42;
    },
  };
  const { engine, called } = withCallLog({
    movers: { createSet: () => handle },
  });
  const set = engine.movers.createSet();
  assert.equal(set, engine.movers.createSet());
  assert.equal(set.set(), 42);
  assert.deepEqual(called(), ['MoverSet.set', 'movers.createSet']);
});

test('getter reads and setters use the original receiver', () => {
  let revision = 7;
  const maps = {
    get terrainRevision() {
      assert.equal(this, maps);
      return revision;
    },
    set terrainRevision(value) {
      assert.equal(this, maps);
      revision = value;
    },
  };
  const { engine, called } = withCallLog({ maps });
  assert.deepEqual(called(), []);
  assert.equal(engine.maps.terrainRevision, 7);
  engine.maps.terrainRevision = 8;
  assert.equal(engine.maps.terrainRevision, 8);
  assert.deepEqual(called(), ['maps.terrainRevision']);
});

test('surface exclusions reach the engine as its original handles', () => {
  const handle = { set() {} };
  const point = {};
  const surface = {
    sampleHeight(position, exclude) {
      assert.equal(position, point);
      assert.equal(exclude[0], handle);
      return 12;
    },
    sampleHeightDetailed(position, { exclude }) {
      assert.equal(position, point);
      assert.equal(exclude[0], handle);
      return { height: 12, source: 'terrain' };
    },
    clampToHeight(position, exclude) {
      assert.equal(exclude[0], handle);
      return position;
    },
    raycast({ exclude }) {
      assert.equal(exclude[0], handle);
      return undefined;
    },
  };
  const { engine } = withCallLog({
    movers: { createSet: () => handle },
    surface,
  });
  const set = engine.movers.createSet();
  const exclude = [set];
  assert.equal(engine.surface.sampleHeight(point, exclude), 12);
  assert.deepEqual(engine.surface.sampleHeightDetailed(point, { exclude }), {
    height: 12,
    source: 'terrain',
  });
  assert.equal(engine.surface.clampToHeight(point, exclude), point);
  assert.equal(engine.surface.raycast({ exclude }), undefined);
  assert.equal(exclude[0], set, 'caller-owned exclusions must stay unchanged');
});

test('unknown members remain undefined or throw the original error', () => {
  const error = new Error('unavailable');
  const camera = {
    get unknown() {
      throw error;
    },
  };
  const { engine, called } = withCallLog({ camera });
  assert.equal(engine.missing, undefined);
  assert.equal(engine.camera.missing, camera.missing);
  assert.throws(() => engine.camera.missing(), TypeError);
  assert.throws(
    () => engine.camera.unknown,
    (caught) => caught === error,
  );
  assert.deepEqual(called(), []);
});

test('follow events retain handle identity, duplicate listeners and removers', () => {
  const followChanged = createEngineEvent();
  const handle = { stop() {}, retarget() {}, target() {} };
  const camera = {
    followChanged,
    follow() {
      followChanged.raiseEvent(handle);
      return handle;
    },
    following: () => handle,
  };
  const { engine } = withCallLog({ camera });
  const seen = [];
  const listener = (value) => seen.push(value);
  const remove = engine.camera.followChanged.addEventListener(listener);
  engine.camera.followChanged.addEventListener(listener);
  const wrapped = engine.camera.follow();
  assert.equal(engine.camera.following(), wrapped);
  assert.deepEqual(seen, [wrapped]);
  assert.equal(engine.camera.followChanged.removeEventListener(listener), true);
  remove();
  engine.camera.follow();
  assert.equal(seen.length, 1);
});

test('contract inventory is sorted, unique and includes required capabilities and handles', () => {
  const members = contractCallMembers();
  assert.deepEqual(members, [...new Set(members)].sort());
  for (const name of [
    'camera.flyTo',
    'maps.terrainRevision',
    'FollowHandle.retarget',
    'Line.setPositions',
    'GroundSet.replace',
    'ImageryLayer.setAlpha',
    'GlobeMesh.update',
  ])
    assert.ok(members.includes(name), name);
  const names = engineContractMembers();
  assert.ok(names.every((name) => members.includes(name)));
  names.length = 0;
  assert.ok(engineContractMembers().length > 0);
});
