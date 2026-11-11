// Edge case for the satellites layer:
// with the clock stopped at a known epoch, switching the scene while a
// satellite is followed leaves the pass list and the coordinates unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createApplicationSatellites } from '../../app/layers/satellites.js';
import { createSatellitesDisplay } from './render/display.js';
import { worldClock } from '../../time/worldClock.js';

// Canonical archived ISS element set (epoch 2008-09-20 ~12:25 UTC).
const ISS_TLE = `ISS (ZARYA)
1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537`;
const EPOCH_MS = Date.UTC(2008, 8, 20, 12, 30, 0);
const AUSTIN = { latDeg: 30.2672, lonDeg: -97.7431 };
// SGP4 is deterministic; this only absorbs float noise between engines.
const POSITION_TOLERANCE_M = 1;

function passList(layer) {
  const passes = [];
  let fromMs;
  for (let i = 0; i < 3; i += 1) {
    const result = layer.getNextSatellitePass(25544, {
      ...AUSTIN,
      ...(fromMs === undefined ? {} : { fromMs }),
    });
    if (result.status !== 'ok') break;
    passes.push(result.pass);
    fromMs = result.pass.setMs + 1_000;
  }
  return passes;
}

function observe(layer, engine) {
  engine.fake.frame();
  const drawn = layer.qaDrawn();
  return {
    info: layer.getTrackedInfo(),
    passes: passList(layer),
    tracked: drawn.tracked,
    point: drawn.points.find(({ id }) => id === 25544)?.position,
  };
}

test('edge:satellites: a scene switch at a stopped epoch keeps passes and coordinates', async (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), {
    getElementById: () => null,
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) });
  worldClock.seek(EPOCH_MS);
  let reads = 0;
  const layer = createApplicationSatellites({
    source: {
      async readGroup(group) {
        reads += 1;
        return {
          ok: true,
          status: 200,
          text: group === 'stations' ? ISS_TLE : '',
          stale: false,
        };
      },
    },
    renderer: {
      create: ({ engine }) => createSatellitesDisplay(engine),
    },
  });
  const [first, second] = [createFakeEngine(), createFakeEngine()];
  t.after(() => {
    layer.destroy();
    worldClock.goLive();
    globalThis.document = previousDocument;
  });
  await layer.init(null, { engine: first });
  layer.enable();
  await layer.update();
  const catalogReads = reads;
  assert.ok(layer.trackById(25544));
  const before = observe(layer, first);
  assert.equal(before.passes.length, 3);
  assert.ok(before.passes[0].riseMs >= EPOCH_MS, 'passes start at the epoch');

  layer.detachRenderer();
  // Wall time passes during the switch; the stopped world clock does not.
  t.mock.timers.tick(15 * 60_000);
  layer.attachRenderer({ engine: second });
  const after = observe(layer, second);

  assert.equal(reads, catalogReads, 'the switch does not refetch elements');
  assert.equal(after.info?.noradId, 25544, 'the follow survives the switch');
  assert.deepEqual(after.passes, before.passes);
  assert.ok(Math.abs(after.info.latitude - before.info.latitude) < 1e-9);
  assert.ok(Math.abs(after.info.longitude - before.info.longitude) < 1e-9);
  assert.ok(Math.abs(after.info.altitudeM - before.info.altitudeM) < 1e-3);
  for (const key of ['tracked', 'point']) {
    assert.ok(before[key] && after[key], `${key} position is drawn`);
    assert.ok(
      geo.cartesian3.distance(before[key], after[key]) < POSITION_TOLERANCE_M,
      `${key} position matches across engines`,
    );
  }
});
