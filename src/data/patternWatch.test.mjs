// Pattern Watch — circling math and the derived-layer lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendSample,
  circlingAssessment,
  isCircling,
  createPatternWatchLayer,
  MIN_TOTAL_TURN_DEG,
  MAX_LOITER_RADIUS_M,
  MIN_SPAN_MS,
} from '../layers/patterns/index.js';

/** Synthetic orbit: radiusM circle at ~centerLat/lon, one sample per step. */
function orbitSamples({
  turns = 3,
  radiusM = 2000,
  stepsPerTurn = 16,
  startMs = 0,
  stepMs = 15000,
  centerLat = 30,
  centerLon = -97,
}) {
  const samples = [];
  const total = Math.round(turns * stepsPerTurn);
  const mPerDegLat = 111320;
  const mPerDegLon = mPerDegLat * Math.cos((centerLat * Math.PI) / 180);
  for (let i = 0; i <= total; i += 1) {
    const angle = (2 * Math.PI * i) / stepsPerTurn;
    samples.push({
      tMs: startMs + i * stepMs,
      lat: centerLat + (radiusM * Math.sin(angle)) / mPerDegLat,
      lon: centerLon + (radiusM * Math.cos(angle)) / mPerDegLon,
    });
  }
  return samples;
}

test('a sustained orbit is flagged; direction does not matter', () => {
  const orbit = circlingAssessment(orbitSamples({ turns: 2.5 }));
  assert.ok(
    Math.abs(orbit.totalTurnDeg) >= MIN_TOTAL_TURN_DEG,
    `2.5 turns must exceed the threshold, got ${orbit.totalTurnDeg}`,
  );
  assert.ok(orbit.radiusM <= MAX_LOITER_RADIUS_M);
  assert.ok(orbit.spanMs >= MIN_SPAN_MS);
  assert.equal(isCircling(orbit), true);

  const reversed = circlingAssessment(
    orbitSamples({ turns: 2.5 }).map((s, i, arr) => ({
      ...arr[arr.length - 1 - i],
      tMs: s.tMs,
    })),
  );
  assert.equal(Math.sign(reversed.totalTurnDeg), -Math.sign(orbit.totalTurnDeg));
  assert.equal(isCircling(reversed), true, 'counter-clockwise flags too');
});

test('orbit tracks crossing the antimeridian retain a local center and radius', () => {
  const assessment = circlingAssessment(
    orbitSamples({ turns: 2.5, centerLon: 179.99 }),
  );
  assert.ok(assessment.radiusM < 2500, `radius was ${assessment.radiusM} m`);
  assert.ok(
    Math.abs(Math.abs(assessment.center.lon) - 180) < 0.02,
    `center longitude was ${assessment.center.lon}`,
  );
  assert.equal(isCircling(assessment), true);
});

test('half-orbit sampling does not invent a turn direction', () => {
  const assessment = circlingAssessment(
    orbitSamples({ turns: 2.5, stepsPerTurn: 2, stepMs: 60_000 }),
  );
  assert.equal(assessment.totalTurnDeg, 0);
  assert.equal(isCircling(assessment), false);
});

test('straight flight and gentle en-route curves never flag', () => {
  const straight = [];
  for (let i = 0; i <= 40; i += 1)
    straight.push({ tMs: i * 15000, lat: 30 + i * 0.01, lon: -97 + i * 0.002 });
  const assessment = circlingAssessment(straight);
  assert.ok(Math.abs(assessment.totalTurnDeg) < 90);
  assert.equal(isCircling(assessment), false);

  // One and a half turns — clearly maneuvering, still under the two-turn bar.
  assert.equal(isCircling(circlingAssessment(orbitSamples({ turns: 1.5 }))), false);
});

test('GPS jitter on a slow aircraft cannot accumulate into a fake orbit', () => {
  // Pseudo-random walk with ~40 m steps — every displacement is under the
  // 150 m segment floor, so no bearings are produced at all.
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5;
  const jitter = [];
  let lat = 30;
  let lon = -97;
  for (let i = 0; i <= 60; i += 1) {
    lat += (rand() * 80) / 111320;
    lon += (rand() * 80) / 96488;
    jitter.push({ tMs: i * 15000, lat, lon });
  }
  const assessment = circlingAssessment(jitter);
  assert.equal(assessment.segments, 0, 'sub-floor wobble yields no segments');
  assert.equal(isCircling(assessment), false);
});

test('the sample buffer enforces spacing, the window, and the cap', () => {
  const track = { samples: [] };
  appendSample(track, { tMs: 0, lat: 30, lon: -97 }, 0);
  // Too soon after the previous sample — dropped.
  appendSample(track, { tMs: 2000, lat: 30.01, lon: -97 }, 2000);
  assert.equal(track.samples.length, 1);
  // Same position — dropped even when late enough.
  appendSample(track, { tMs: 20000, lat: 30, lon: -97 }, 20000);
  assert.equal(track.samples.length, 1);
  appendSample(track, { tMs: 30000, lat: 30.01, lon: -97 }, 30000);
  assert.equal(track.samples.length, 2);
  // Twelve-minute window: the first sample ages out.
  appendSample(track, { tMs: 800000, lat: 30.02, lon: -97 }, 800000);
  assert.deepEqual(
    track.samples.map((s) => s.tMs),
    [30000, 800000].filter((t) => t >= 800000 - 12 * 60 * 1000),
  );
});

test('the derived layer flags a circler from its feeds and reports honestly', async () => {
  const orbit = orbitSamples({ turns: 3, stepsPerTurn: 16 });
  let step = 0;
  let requestedLimit = 0;
  const flights = {
    getAnalystRecords: (limit) => {
      requestedLimit = limit;
      return step < orbit.length
        ? [
            {
              id: step < orbit.length / 2 ? 'OLD CALL' : 'NEW CALL',
              icao24: 'abc123',
              callsign: step < orbit.length / 2 ? 'OLD CALL' : 'NEW CALL',
              lat: orbit[step].lat,
              lon: orbit[step].lon,
              altitudeM: 900,
              onGround: false,
            },
            // A parked aircraft never enters a track.
            { id: 'GROUND', callsign: 'GROUND', lat: 30, lon: -97, onGround: true },
          ]
        : [];
    },
  };
  let overlayEntries = [];
  const overlayHost = {
    setEntries: (_sourceId, entries) => {
      overlayEntries = entries;
    },
    setVisible() {},
    clearSource: () => {
      overlayEntries = [];
    },
  };
  const layer = createPatternWatchLayer({
    services: { flights },
    overlayHost,
  });
  let dataSource = null;
  const viewer = {
    dataSources: {
      add: (value) => {
        dataSource = value;
      },
      remove() {},
    },
  };
  const realNow = Date.now;
  try {
    layer.init(viewer);
    layer.enable();
    assert.match(
      layer.getStats().loadingLabel,
      /few minutes of history/,
      'an empty result explains itself instead of showing a silent zero',
    );
    for (step = 0; step < orbit.length; step += 1) {
      Date.now = () => orbit[step].tMs;
      layer.update();
    }
    const flagged = layer.getAnalystRecords();
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].callsign, 'NEW CALL');
    assert.ok(requestedLimit > 2000, 'the sweep bypasses the analyst default cap');
    assert.ok(flagged[0].turns >= 2);
    const entities = dataSource.entities.values;
    assert.equal(entities.length, 1);
    assert.equal(overlayEntries.length, 1);
    assert.match(overlayEntries[0].title, /^CIRCLING · NEW CALL/);
    assert.match(
      overlayEntries[0].details[0],
      /^\d+\.\d+ TURNS · \d+ minutes$/,
    );
    assert.equal(layer.getStats().countLabel, '1 circling');
    layer.disable();
    assert.deepEqual(overlayEntries, []);
    assert.deepEqual(layer.getAnalystRecords(), []);
  } finally {
    Date.now = realNow;
    layer.destroy(viewer);
  }
});

test('a feed that goes quiet ages the track out instead of flagging forever', async () => {
  let records = [];
  const layer = createPatternWatchLayer({
    services: { flights: { getAnalystRecords: () => records } },
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
    },
  });
  const viewer = { dataSources: { add() {}, remove() {} } };
  const realNow = Date.now;
  try {
    layer.init(viewer);
    layer.enable();
    records = [{ id: 'X', callsign: 'X', lat: 30, lon: -97, onGround: false }];
    Date.now = () => 0;
    layer.update();
    records = [];
    Date.now = () => 13 * 60 * 1000;
    layer.update();
    assert.deepEqual(layer.getAnalystRecords(), []);
  } finally {
    Date.now = realNow;
    layer.destroy(viewer);
  }
});
