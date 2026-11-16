import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  historyAfterTrail,
  historyBracketIndex,
  historyUnseenAt,
  liftGroundedHistory,
  mergeAircraftTimelineFixes,
} from './timelineHistory.js';

const META = { renderAltitudeM: 3_000 };
const fix = (atMs, lat, altitudeM = null, lon = 0) => ({
  atMs,
  lat,
  lon,
  altitudeM,
});
const julian = (ms) => Cesium.JulianDate.fromDate(new Date(ms));

test('an aircraft with no fixes merges nothing', () => {
  assert.equal(
    mergeAircraftTimelineFixes([], { fixes: null }, META, 100, 0),
    null,
  );
});

test("an aircraft's fixes join its history in order, each at the render height moved by its own climb", () => {
  const history = mergeAircraftTimelineFixes(
    [],
    {
      baroAltitudeM: 1_000,
      fixes: [fix(120_000, 1, 1_200), fix(60_000, 0, 1_000), fix(180_000, 2)],
    },
    META,
    100,
    120_000,
  );
  assert.deepEqual(
    history.map((entry) => entry.epochMs),
    [60_000, 120_000, 180_000],
  );
  const height = (entry) =>
    Cesium.Cartographic.fromCartesian(entry.position).height;
  assert.ok(Math.abs(height(history[0]) - 3_000) < 1e-3);
  assert.ok(Math.abs(height(history[1]) - 3_200) < 1e-3);
  assert.ok(
    Math.abs(height(history[2]) - 3_000) < 1e-3,
    'no altitude: the render height',
  );
  // A later snapshot's fixes add to the earlier ones.
  const more = mergeAircraftTimelineFixes(
    history,
    { baroAltitudeM: 1_000, fixes: [fix(180_000, 2), fix(240_000, 3)] },
    META,
    100,
    180_000,
  );
  assert.deepEqual(
    more.map((entry) => entry.epochMs),
    [60_000, 120_000, 180_000, 240_000],
  );
});

test('the bracketing entry is the first at or after the time, else the last', () => {
  const history = [1_000, 2_000, 3_000].map((ms) => ({
    time: Cesium.JulianDate.fromDate(new Date(ms)),
  }));
  const at = (ms) =>
    historyBracketIndex(history, Cesium.JulianDate.fromDate(new Date(ms)));
  assert.equal(at(500), 0);
  assert.equal(at(1_000), 0);
  assert.equal(at(1_500), 1);
  assert.equal(at(3_000), 2);
  assert.equal(at(9_000), 2);
});

test('each fix heads where the track goes next, the last where it came from', () => {
  const history = mergeAircraftTimelineFixes(
    [],
    {
      fixes: [
        fix(0, 0, null, 0),
        fix(60_000, 0, null, 0.01),
        fix(120_000, 0.01, null, 0.01),
        fix(180_000, 0.01, null, 0.01),
      ],
    },
    META,
    100,
    0,
  );
  const tracks = history.map((entry) => entry.track);
  assert.ok(Math.abs(tracks[0] - 90) < 0.5, 'east');
  assert.ok(Math.abs(tracks[1]) < 0.5, 'north');
  assert.equal(tracks[2], undefined, 'no move to read');
  assert.equal(tracks[3], undefined);
  assert.ok(history.every((entry) => entry.timeline === true));
});

test('a contact is unseen only well before the first of its own fixes', () => {
  const history = mergeAircraftTimelineFixes(
    [],
    { fixes: [fix(600_000, 0), fix(660_000, 1)] },
    META,
    100,
    600_000,
  );
  assert.equal(historyUnseenAt(history, julian(0)), true);
  assert.equal(historyUnseenAt(history, julian(560_000)), false);
  const live = [{ time: julian(600_000) }];
  assert.equal(historyUnseenAt(live, julian(0)), false, 'not on its fixes');
  assert.equal(historyUnseenAt(undefined, julian(0)), false);
});

test('a grounded contact on its own fixes is lifted whole; else its newest fix', () => {
  const height = (entry) =>
    Cesium.Cartographic.fromCartesian(entry.position).height;
  const history = mergeAircraftTimelineFixes(
    [],
    { fixes: [fix(0, 0), fix(60_000, 0.001)] },
    { renderAltitudeM: 5 },
    0,
    0,
  );
  const lifted = Cesium.Cartesian3.fromDegrees(0, 0.001, 30);
  liftGroundedHistory(history, lifted, 5, 30);
  assert.ok(history.every((entry) => Math.abs(height(entry) - 30) < 1e-3));
  const live = [
    { position: Cesium.Cartesian3.fromDegrees(0, 0, 5) },
    { position: Cesium.Cartesian3.fromDegrees(0, 0.001, 5) },
  ];
  liftGroundedHistory(live, lifted, 5, 30);
  assert.ok(Math.abs(height(live[0]) - 5) < 1e-3);
  assert.ok(Math.abs(height(live[1]) - 30) < 1e-3);
});

test("a tracked trail takes the fixes after its newest point, up to the snapshot's time", () => {
  const history = [0, 60_000, 120_000, 180_000].map((epochMs) => ({ epochMs }));
  assert.deepEqual(
    historyAfterTrail(history, [{ timeMs: 60_000 }], 120_000).map(
      (entry) => entry.epochMs,
    ),
    [120_000],
  );
  assert.equal(historyAfterTrail(history, [], 120_000).length, 3);
});
