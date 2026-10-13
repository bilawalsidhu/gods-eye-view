import assert from 'node:assert/strict';
import test from 'node:test';

import { destinationPointDeg } from '../alpr/model.js';
import { greatCircleKm } from '../../data/routePlausible.js';
import {
  createHorizonModel,
  horizonArcs,
  horizonBandIndex,
  horizonOutline,
  validAntennaPosition,
} from './model.js';
import { HORIZON_BANDS, HORIZON_MAX_RANGE_KM } from './policy.js';

const ANTENNA = Object.freeze({ lat: 30.2672, lon: -97.7431 });

/** A fix `rangeKm` from the antenna on `bearingDeg`. */
function fixAt(bearingDeg, rangeKm, altitudeFt = 30_000, extra = {}) {
  const { latitude, longitude } = destinationPointDeg(
    ANTENNA.lat,
    ANTENNA.lon,
    bearingDeg,
    rangeKm * 1000,
  );
  return {
    icao: 'abc123',
    lat: latitude,
    lon: longitude,
    altitudeFt,
    onGround: false,
    at: 1_000,
    ...extra,
  };
}

function band(snapshot, id) {
  return snapshot.bands.find((entry) => entry.id === id);
}

test('altitudes fall into five bands with inclusive lower bounds', () => {
  assert.equal(horizonBandIndex(-400), 0);
  assert.equal(horizonBandIndex(4_999), 0);
  assert.equal(horizonBandIndex(5_000), 1);
  assert.equal(horizonBandIndex(24_999), 2);
  assert.equal(horizonBandIndex(35_000), 4);
  assert.equal(horizonBandIndex(60_000), 4);
  assert.equal(horizonBandIndex(null), -1);
  assert.equal(horizonBandIndex(Number.NaN), -1);
  assert.equal(HORIZON_BANDS.length, 5);
});

test('an antenna needs finite, in-range coordinates and is never 0,0', () => {
  assert.deepEqual(validAntennaPosition({ lat: 30.5, lon: -97.25 }), {
    lat: 30.5,
    lon: -97.25,
  });
  assert.equal(validAntennaPosition({ lat: 0, lon: 0 }), null);
  assert.equal(validAntennaPosition({ lat: 91, lon: 0 }), null);
  assert.equal(validAntennaPosition({ lat: 10, lon: 181 }), null);
  assert.equal(validAntennaPosition({ lat: 'x', lon: 2 }), null);
  assert.equal(
    validAntennaPosition({ lat: null, lon: 5 }),
    null,
    'null is not 0',
  );
  assert.equal(validAntennaPosition(null), null);
});

test('positions heard before the antenna is known are placed once it is', () => {
  const model = createHorizonModel();
  model.ingest(fixAt(90, 150));
  model.ingest(fixAt(180, 120, 12_000, { icao: 'def456' }));
  let snapshot = model.snapshot();
  assert.equal(snapshot.antenna, null);
  assert.equal(snapshot.pending, 2);
  assert.equal(snapshot.counted, 0);
  assert.equal(snapshot.farthest, null);

  assert.equal(model.setAntenna(ANTENNA), true);
  snapshot = model.snapshot();
  assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.counted, 2);
  assert.equal(snapshot.aircraft, 2);
  assert.equal(band(snapshot, '25k-35k').directions, 1);
  assert.equal(band(snapshot, '5k-15k').directions, 1);
  assert.ok(Math.abs(snapshot.farthest.rangeKm - 150) < 0.5);
  assert.ok(Math.abs(snapshot.farthest.bearingDeg - 90) < 0.5);
  assert.equal(snapshot.farthest.bandId, '25k-35k');
});

test('the farthest position wins each direction; nearer ones only count', () => {
  const model = createHorizonModel();
  model.setAntenna(ANTENNA);
  // Bins are 5° wide and centred on multiples of 5°: 45.6–46.4° share bin 9.
  assert.equal(model.ingest(fixAt(46, 100)), true);
  const before = model.snapshot().shapeVersion;
  assert.equal(model.ingest(fixAt(46.4, 80)), false, 'same direction, nearer');
  assert.equal(model.snapshot().shapeVersion, before);
  assert.equal(model.snapshot().counted, 2);
  assert.equal(model.ingest(fixAt(45.6, 210)), true, 'same direction, farther');
  const snapshot = model.snapshot();
  assert.equal(band(snapshot, '25k-35k').directions, 1);
  assert.ok(Math.abs(band(snapshot, '25k-35k').maxRangeKm - 210) < 0.5);
});

test('directions either side of north share the north bin', () => {
  const model = createHorizonModel();
  model.setAntenna(ANTENNA);
  model.ingest(fixAt(359.5, 100));
  model.ingest(fixAt(0.5, 140));
  model.ingest(fixAt(3.5, 90));
  const snapshot = band(model.snapshot(), '25k-35k');
  assert.equal(
    snapshot.directions,
    2,
    '359.5° and 0.5° share bin 0; 3.5° is bin 1',
  );
});

test('implausibly distant, grounded and altitude-less positions are never drawn', () => {
  const model = createHorizonModel();
  model.setAntenna(ANTENNA);
  model.ingest(fixAt(10, HORIZON_MAX_RANGE_KM + 50));
  model.ingest(fixAt(20, 100, 30_000, { onGround: true }));
  model.ingest(fixAt(30, 100, null));
  const snapshot = model.snapshot();
  assert.equal(snapshot.implausible, 1);
  assert.equal(snapshot.counted, 0);
  assert.equal(
    snapshot.buffered,
    1,
    'only the airborne, altitude-bearing fix is kept',
  );
  assert.equal(snapshot.farthest, null);
  for (const entry of snapshot.bands) assert.equal(entry.directions, 0);
});

test('a position directly overhead counts but has no direction', () => {
  const model = createHorizonModel();
  model.setAntenna(ANTENNA);
  assert.equal(
    model.ingest({ ...ANTENNA, altitudeFt: 3_000, icao: 'a1', at: 5 }),
    false,
  );
  const snapshot = model.snapshot();
  assert.equal(snapshot.counted, 1);
  assert.equal(band(snapshot, 'below-5k').directions, 0);
});

test('outline runs join neighbours, wrap across north and break at open sectors', () => {
  // 2° bins here, so 15 bins span the 30° gap rule exactly.
  const arcs2 = (bins) => horizonArcs(bins, { binDeg: 2 });
  const bins = (indexes) => {
    const out = new Array(180).fill(null);
    for (const index of indexes) out[index] = { index };
    return out;
  };
  const ids = (arcs) =>
    arcs.map(({ closed, points }) => [closed, points.map((p) => p.index)]);

  const all = Array.from({ length: 180 }, (_, index) => index);
  const full = arcs2(bins(all));
  assert.equal(full.length, 1);
  assert.equal(full[0].closed, true);
  assert.equal(full[0].points.length, 180);

  // Every 15th bin is exactly 30° apart: still continuous all the way round.
  assert.deepEqual(
    ids(arcs2(bins([0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165]))).map(
      ([closed]) => closed,
    ),
    [true],
  );

  // A 40° hole (bins 10..29 empty) opens the ring; the run starts after it
  // and wraps across north.
  const holed = all.filter((index) => index < 10 || index >= 30);
  const [open] = arcs2(bins(holed));
  assert.equal(open.closed, false);
  assert.equal(open.points[0].index, 30);
  assert.equal(open.points.at(-1).index, 9);
  assert.equal(open.points.length, 160);

  // Two separate sectors, neither touching north.
  assert.deepEqual(ids(arcs2(bins([40, 41, 42, 100, 101]))), [
    [false, [40, 41, 42]],
    [false, [100, 101]],
  ]);

  // Two holes with the run across north joined.
  assert.deepEqual(ids(arcs2(bins([170, 175, 0, 5, 60, 65]))), [
    [false, [60, 65]],
    [false, [170, 175, 0, 5]],
  ]);

  // An isolated direction cannot draw; too few directions draw nothing.
  assert.deepEqual(ids(arcs2(bins([10, 11, 12, 90]))), [[false, [10, 11, 12]]]);
  assert.deepEqual(arcs2(bins([10, 11])), []);
});

test('the outline sweeps between heard directions instead of cutting a chord', () => {
  const model = createHorizonModel();
  model.setAntenna(ANTENNA);
  model.ingest(fixAt(90, 100));
  model.ingest(fixAt(100, 200));
  model.ingest(fixAt(105, 200));
  const [arc] = band(model.snapshot(), '25k-35k').arcs;
  const path = horizonOutline(arc, ANTENNA);
  assert.equal(path.length, 16, '10° then 5° in 1° steps, both ends included');
  // Halfway between 90° @ 100 km and 100° @ 200 km the outline is at 95° and
  // 150 km; a straight chord would pass well inside that.
  const middle = path[5];
  assert.ok(
    Math.abs(
      greatCircleKm(ANTENNA.lat, ANTENNA.lon, middle.lat, middle.lon) - 150,
    ) < 1,
  );

  const ring = createHorizonModel();
  ring.setAntenna(ANTENNA);
  for (let bearing = 0; bearing < 360; bearing += 5)
    ring.ingest(fixAt(bearing, 300));
  const [closed] = band(ring.snapshot(), '25k-35k').arcs;
  assert.equal(closed.closed, true);
  const loop = horizonOutline(closed, ANTENNA);
  assert.equal(loop.length, 72 * 5 + 1);
  assert.deepEqual(loop.at(-1), loop[0], 'a closed ring returns to its start');
  for (const point of loop)
    assert.ok(
      Math.abs(
        greatCircleKm(ANTENNA.lat, ANTENNA.lon, point.lat, point.lon) - 300,
      ) < 2,
    );
});

test('moving the antenna rebuilds the horizon around the new centre', () => {
  const model = createHorizonModel();
  model.setAntenna(ANTENNA);
  model.ingest(fixAt(90, 200));
  const east = model.snapshot().farthest;
  assert.ok(Math.abs(east.rangeKm - 200) < 0.5);

  // A few metres is the same antenna.
  assert.equal(
    model.setAntenna({ lat: ANTENNA.lat + 0.0001, lon: ANTENNA.lon }),
    false,
  );

  // 100 km east of the old antenna: the same fix is now ~100 km away.
  const moved = destinationPointDeg(ANTENNA.lat, ANTENNA.lon, 90, 100_000);
  assert.equal(
    model.setAntenna({ lat: moved.latitude, lon: moved.longitude }),
    true,
  );
  const rebuilt = model.snapshot();
  assert.ok(Math.abs(rebuilt.farthest.rangeKm - 100) < 1);
  assert.equal(rebuilt.counted, 1);

  assert.equal(model.setAntenna(null), true);
  assert.equal(model.snapshot().pending, 1);
  assert.equal(model.snapshot().farthest, null);
});

test('the rebuild buffer keeps only the newest positions', () => {
  const model = createHorizonModel({ bufferSize: 3 });
  for (const [bearing, icao] of [
    [10, 'a'],
    [20, 'b'],
    [30, 'c'],
    [40, 'd'],
  ])
    model.ingest(fixAt(bearing, 100, 30_000, { icao }));
  model.setAntenna(ANTENNA);
  const snapshot = model.snapshot();
  assert.equal(snapshot.buffered, 3);
  assert.equal(snapshot.counted, 3);
  assert.equal(snapshot.aircraft, 3);
  assert.equal(band(snapshot, '25k-35k').directions, 3);
});

test('reset forgets every position but keeps the antenna', () => {
  const model = createHorizonModel();
  model.setAntenna(ANTENNA);
  model.ingest(fixAt(90, 150, 30_000, { at: 42 }));
  model.ingest(fixAt(95, 150));
  model.ingest(fixAt(100, 150));
  assert.equal(band(model.snapshot(), '25k-35k').arcs.length, 1);
  model.reset();
  const snapshot = model.snapshot();
  assert.deepEqual(snapshot.antenna, ANTENNA);
  assert.equal(snapshot.counted, 0);
  assert.equal(snapshot.buffered, 0);
  assert.equal(snapshot.lastFixAt, null);
  assert.equal(band(snapshot, '25k-35k').arcs.length, 0);
});

test('snapshots are cached until the next change', () => {
  const model = createHorizonModel();
  model.setAntenna(ANTENNA);
  const first = model.snapshot();
  assert.equal(model.snapshot(), first);
  model.ingest(fixAt(90, 150));
  assert.notEqual(model.snapshot(), first);
  assert.ok(Object.isFrozen(model.snapshot()));
});
