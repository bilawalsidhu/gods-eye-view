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
