// Live trains — records, source validation, and layer lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  trainHeadingDeg,
  normalizeTrainsPayload,
  createAmtrakerTrainSource,
  createLiveTrainsLayer,
  trainStatusLine,
} from '../layers/trains/index.js';

const activeTrain = (overrides = {}) => ({
  trainID: '1-16',
  trainNum: '1',
  routeName: 'Sunset Limited',
  trainState: 'Active',
  lat: 29.691,
  lon: -91.323,
  velocity: 60.3,
  heading: 'W',
  eventName: 'New Iberia',
  origName: 'New Orleans',
  destName: 'Los Angeles Union',
  trainTimely: '12 Minutes Late',
  iconColor: '#2a9128',
  provider: 'Amtrak',
  lastValTS: '2026-09-16T11:10:40-05:00',
  ...overrides,
});

test('compass headings map to bearings; junk reads as missing', () => {
  assert.equal(trainHeadingDeg('W'), 270);
  assert.equal(trainHeadingDeg(' ne '), 45);
  assert.equal(trainHeadingDeg('N'), 0);
  assert.equal(trainHeadingDeg('north'), null);
  assert.equal(trainHeadingDeg(''), null);
  assert.equal(trainHeadingDeg(undefined), null);
});

test('normalization keeps Active trains, drops the rest, and dedupes by id', () => {
  const rows = normalizeTrainsPayload({
    1: [activeTrain(), activeTrain()], // duplicate id — one record
    2: [activeTrain({ trainID: '2-16', trainState: 'Predeparture' })],
    3: [activeTrain({ trainID: '3-16', lat: 95 })],
    4: [activeTrain({ trainID: '', trainNum: '4' })],
    5: [activeTrain({ trainID: '5-16', iconColor: 'javascript:alert(1)' })],
  });
  assert.deepEqual(
    rows.map((r) => r.id),
    ['train:1-16', 'train:5-16'],
  );
  assert.equal(rows[0].routeName, 'Sunset Limited');
  assert.equal(rows[0].velocityMph, 60);
  assert.equal(rows[0].headingDeg, 270);
  assert.equal(rows[0].timeliness, '12 Minutes Late');
  assert.equal(rows[0].accent, '#2a9128');
  assert.equal(rows[1].accent, null, 'a non-hex icon color never reaches CSS');
});

test('a structurally invalid payload is a failure, an empty network is not', () => {
  assert.equal(normalizeTrainsPayload(null), null);
  assert.equal(normalizeTrainsPayload([1, 2]), null);
  assert.deepEqual(normalizeTrainsPayload({}), []);
});

test('the source validates HTTP status and payload shape', async () => {
  const source = createAmtrakerTrainSource({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(() => source.getSnapshot(), /Amtraker HTTP 503/);
  const malformed = createAmtrakerTrainSource({
    fetchImpl: async () => ({ ok: true, json: async () => 'nope' }),
  });
  await assert.rejects(() => malformed.getSnapshot(), /Malformed Amtraker/);
});

function trainViewer() {
  let dataSource = null;
  return {
    get dataSource() {
      return dataSource;
    },
    dataSources: {
      add: (value) => {
        dataSource = value;
      },
      remove() {
        dataSource = null;
      },
    },
  };
}

test('the layer renders the fleet with status labels and honest stats', async () => {
  const layer = createLiveTrainsLayer({
    source: {
      label: 'Amtrak · Amtraker community API',
      async getSnapshot() {
        return normalizeTrainsPayload({
          1: [activeTrain()],
          2: [
            activeTrain({
              trainID: '22-16',
              trainNum: '22',
              routeName: 'Texas Eagle',
              velocity: null,
              eventName: null,
            }),
          ],
        });
      },
    },
  });
  const viewer = trainViewer();
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  const entities = viewer.dataSource.entities.values;
  assert.equal(entities.length, 2);
  assert.equal(
    entities[0].label.text.getValue(),
    'SUNSET LIMITED 1\n60 MPH → NEW IBERIA',
  );
  assert.equal(
    entities[1].label.text.getValue(),
    'TEXAS EAGLE 22',
    'missing speed and station leave a clean one-line label',
  );
  assert.equal(layer.getStats().count, 2);
  assert.equal(layer.getStats().countLabel, '2 active');
  const analyst = layer.getAnalystRecords();
  assert.equal(analyst.length, 2);
  assert.equal(analyst[0].nextStation, 'New Iberia');
  layer.disable();
  assert.deepEqual(layer.getAnalystRecords(), [], 'disabled answers empty');
  layer.destroy(viewer);
});

test('a failed refresh keeps the previous fleet and reports the error', async () => {
  let fail = false;
  const layer = createLiveTrainsLayer({
    source: {
      async getSnapshot() {
        if (fail) throw new Error('Amtraker HTTP 503');
        return normalizeTrainsPayload({ 1: [activeTrain()] });
      },
    },
  });
  const viewer = trainViewer();
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  fail = true;
  assert.equal(await layer.update(), false);
  assert.equal(
    viewer.dataSource.entities.values.length,
    1,
    'warm data is preserved through an outage',
  );
  assert.match(layer.getStats().error, /Amtraker HTTP 503/);
  layer.destroy(viewer);
});

test('status line composes only from supplied fields', () => {
  assert.equal(
    trainStatusLine({ velocityMph: 79, nextStation: 'Austin' }),
    '79 MPH → AUSTIN',
  );
  assert.equal(trainStatusLine({ velocityMph: 0, nextStation: null }), '0 MPH');
  assert.equal(trainStatusLine({ velocityMph: null, nextStation: null }), '');
});

test('dead reckoning moves along the line two real fixes define, then rests', async () => {
  const { trainShownDegrees, parseFixTimeMs } = await import(
    '../layers/trains/records.js'
  );
  const track = {
    fixes: [
      { timeMs: 0, lon: 0, lat: 0 },
      { timeMs: 60000, lon: 0.01, lat: 0.005 },
    ],
  };
  // Halfway into the next minute: half the last leg again, same direction.
  assert.deepEqual(trainShownDegrees(track, 90000, 120000), {
    lon: 0.015,
    lat: 0.0075,
  });
  // Ten minutes of silence: carry-forward clamps at two minutes.
  assert.deepEqual(trainShownDegrees(track, 600000, 120000), {
    lon: 0.03,
    lat: 0.015,
  });
  // Never behind the latest fix.
  assert.deepEqual(trainShownDegrees(track, 30000, 120000), {
    lon: 0.01,
    lat: 0.005,
  });
  // One fix, or a non-advancing pair, holds still.
  assert.deepEqual(
    trainShownDegrees({ fixes: [{ timeMs: 0, lon: 1, lat: 2 }] }, 900000, 120000),
    { lon: 1, lat: 2 },
  );
  assert.deepEqual(
    trainShownDegrees(
      { fixes: [{ timeMs: 5, lon: 9, lat: 9 }, { timeMs: 5, lon: 1, lat: 2 }] },
      900000,
      120000,
    ),
    { lon: 1, lat: 2 },
  );
  assert.equal(parseFixTimeMs('2026-09-16T11:10:40-05:00'), 1789575040000);
  assert.equal(parseFixTimeMs('not a time'), null);
  assert.equal(parseFixTimeMs(null), null);
});

test('entities persist across polls; new fixes move them, stale fixes do not', async () => {
  let poll = 0;
  const layer = createLiveTrainsLayer({
    source: {
      async getSnapshot() {
        poll += 1;
        return normalizeTrainsPayload({
          1: [
            activeTrain({
              lon: -91.3 - poll * 0.01,
              lastValTS: `2026-09-16T11:1${poll}:00-05:00`,
              trainTimely: poll === 1 ? 'On Time' : '5 Minutes Late',
            }),
          ],
        });
      },
    },
  });
  const viewer = trainViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const first = viewer.dataSource.entities.getById('train:1-16');
  assert.ok(first);
  await layer.update();
  assert.equal(
    viewer.dataSource.entities.getById('train:1-16'),
    first,
    'the same entity survives a refresh instead of being rebuilt',
  );
  assert.match(first.label.text.getValue(), /5 MINUTES LATE|60 MPH/);
  const shown = first.position.getValue(Cesium.JulianDate.now());
  assert.ok(shown instanceof Cesium.Cartesian3, 'position stays computable');
  layer.destroy(viewer);
});

test('completed trains leave the display on the next poll', async () => {
  let second = false;
  const layer = createLiveTrainsLayer({
    source: {
      async getSnapshot() {
        return normalizeTrainsPayload(
          second
            ? { 2: [activeTrain({ trainID: '2-16', trainNum: '2' })] }
            : {
                1: [activeTrain()],
                2: [activeTrain({ trainID: '2-16', trainNum: '2' })],
              },
        );
      },
    },
  });
  const viewer = trainViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(viewer.dataSource.entities.values.length, 2);
  second = true;
  await layer.update();
  assert.equal(viewer.dataSource.entities.values.length, 1);
  assert.equal(viewer.dataSource.entities.getById('train:1-16'), undefined);
  layer.destroy(viewer);
});

test('the layer holds the render loop while enabled and releases it after', async () => {
  const calls = [];
  const layer = createLiveTrainsLayer({
    source: {
      async getSnapshot() {
        return [];
      },
    },
    services: {
      render: {
        holdContinuousRender: (owner) => calls.push(['hold', owner]),
        releaseContinuousRender: (owner) => calls.push(['release', owner]),
      },
    },
  });
  const viewer = trainViewer();
  layer.init(viewer);
  layer.enable();
  layer.disable();
  layer.enable();
  layer.destroy(viewer);
  assert.deepEqual(calls, [
    ['hold', 'live-trains'],
    ['release', 'live-trains'],
    ['hold', 'live-trains'],
    ['release', 'live-trains'],
  ]);
});
