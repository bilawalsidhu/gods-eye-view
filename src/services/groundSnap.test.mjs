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

test('a coarse tile answer or only terrain is a miss', async () => {
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
    tileSizeM: 241,
  }));
  assert.equal(snap.heightFor(engine, 'd3', KAUS), 122.5);
  assert.equal(snap.heightFor(null, 'd4', KAUS), null, 'no engine: no sample');
});

const atDenverAirport = geo.cartesian3.fromDegrees(-104.6737, 39.8561, 0);
function timedEngine() {
  const engine = createFakeEngine();
  engine.fake.script('sampleHeight', () => 1650);
  return engine;
}
test('a clock that steps back opens a new sample window instead of denying samples until it catches up', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const viewer = timedEngine();
  const snap = createGroundSnap({ groundFloor: groundFloor() });
  const icaos = ['a00001', 'a00002', 'a00003', 'a00004', 'a00005', 'a00006'];
  for (const icao of icaos) snap.heightFor(viewer, icao, atDenverAirport);
  assert.equal(
    viewer.fake.callsOf('surface.sampleHeightDetailed').length,
    4,
    'four samples per 250 ms window',
  );
  t.mock.timers.setTime(1_000_000 - 60_000);
  for (const icao of icaos) snap.heightFor(viewer, icao, atDenverAirport);
  assert.equal(
    viewer.fake.callsOf('surface.sampleHeightDetailed').length,
    6,
    'the two denied aircraft sample in the new window',
  );
});

test('a retry backoff stamped before the clock stepped back does not wait for it to catch up', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000_000 });
  const viewer = timedEngine();
  const snap = createGroundSnap({ groundFloor: groundFloor() });
  // Tiles still streaming: a miss, backed off for 2 s.
  viewer.fake.script('tilesLoaded', false);
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), null);
  viewer.fake.script('tilesLoaded', true);
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), null);
  assert.equal(
    viewer.fake.callsOf('surface.sampleHeightDetailed').length,
    0,
    'the backoff holds',
  );
  // The clock steps back an hour: the stamp is an hour off, past any backoff.
  t.mock.timers.setTime(10_000_000 - 3_600_000);
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), 1650);
  assert.equal(viewer.fake.callsOf('surface.sampleHeightDetailed').length, 1);
});
