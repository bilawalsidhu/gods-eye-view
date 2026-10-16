import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../geo/index.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { createGroundSnap } from './groundSnap.js';

const groundFloor = (reports = []) => ({
  cachedMeshFloor: () => null,
  meshFloorPreferred: () => true,
  reportValidatedMeshFloorCell: (...args) => reports.push(args),
});
const KAUS = geo.cartesian3.fromDegrees(-97.67, 30.19, 0);

test('on a globe engine a snap samples engine.surface once and caches it', () => {
  const reports = [];
  const snap = createGroundSnap({ groundFloor: groundFloor(reports) });
  const engine = createFakeEngine();
  engine.fake.script('sampleHeight', () => 138.5);
  let exclusions = 0;
  const exclude = () => {
    exclusions++;
    return ['own-model'];
  };
  assert.equal(snap.heightFor(engine, 'a1', KAUS, exclude), 138.5);
  assert.equal(snap.heightFor(engine, 'a1', KAUS, exclude), 138.5);
  const calls = engine.fake.callsOf('surface.sampleHeightDetailed');
  assert.equal(calls.length, 1, 'one sample, then the cache');
  assert.deepEqual(calls[0].args[1].exclude, ['own-model']);
  assert.equal(exclusions, 1);
  assert.ok(
    Math.abs(geo.math.toDegrees(calls[0].args[0].latitude) - 30.19) < 1e-9,
  );
  assert.equal(reports.length, 1, 'the sample feeds the mesh floor');
});

test('on a globe engine loading tiles or a miss return null without a sample cache', () => {
  const snap = createGroundSnap({ groundFloor: groundFloor() });
  const engine = createFakeEngine();
  engine.fake.script('tilesLoaded', false);
  engine.fake.script('sampleHeight', () => 10);
  assert.equal(snap.heightFor(engine, 'b1', KAUS), null);
  assert.equal(engine.fake.callsOf('surface.sampleHeightDetailed').length, 0);
  engine.fake.script('tilesLoaded', true);
  engine.fake.script('sampleHeight', () => undefined);
  assert.equal(snap.heightFor(engine, 'c1', KAUS), null);
  assert.equal(engine.fake.callsOf('surface.sampleHeightDetailed').length, 1);
  assert.equal(
    snap.heightFor(engine, 'c1', KAUS),
    null,
    'backoff after a miss',
  );
  assert.equal(engine.fake.callsOf('surface.sampleHeightDetailed').length, 1);
});

test('a coarse tile answer or only terrain is a miss; a viewer reaches its engine', async () => {
  const { registerViewerEngine } =
    await import('../globe/cesium/engineFromViewer.js');
  const snap = createGroundSnap({ groundFloor: groundFloor() });
  const engine = createFakeEngine();
  engine.fake.script('sampleHeightDetailed', () => ({
    height: 143.2,
    source: 'tiles',
    tileSizeM: 27_914,
  }));
  assert.equal(snap.heightFor(engine, 'd1', KAUS), null, 'coarse');
  engine.fake.script('sampleHeightDetailed', () => ({
    height: 121,
    source: 'terrain',
  }));
  assert.equal(snap.heightFor(engine, 'd2', KAUS), null, 'terrain');
  engine.fake.script('sampleHeightDetailed', () => ({
    height: 122.5,
    source: 'tiles',
    tileSizeM: 1_797,
  }));
  const viewer = {};
  const unregister = registerViewerEngine(viewer, engine);
  try {
    assert.equal(snap.heightFor(viewer, 'd3', KAUS), 122.5);
  } finally {
    unregister();
  }
  assert.equal(snap.heightFor({}, 'd4', KAUS), null, 'no engine: no sample');
});
