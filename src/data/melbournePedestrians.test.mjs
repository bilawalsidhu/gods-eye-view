// Melbourne pedestrian counters — pure records, source join, layer lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  windowStartIso,
  parseSensingMs,
  normalizeSensors,
  normalizeCounts,
  intensityTier,
  mergePedestrianRecords,
  pedestrianCountLabel,
  createMelbournePedestrianSource,
  createPedestriansLayer,
} from '../layers/pedestrians/index.js';

const sensorRow = (id, over = {}) => ({
  location_id: id,
  sensor_description: `Sensor ${id}`,
  status: 'A',
  latitude: -37.81 + id * 0.001,
  longitude: 144.96 + id * 0.001,
  direction_1: 'North',
  direction_2: 'South',
  ...over,
});

test('windowStartIso subtracts the window in UTC from the feed anchor', () => {
  // A UTC instant whose Melbourne-local calendar day is the NEXT day.
  const asOfMs = Date.parse('2026-09-16T21:34:00Z');
  assert.equal(windowStartIso(asOfMs, 15), '2026-09-16T21:19:00.000Z');
  assert.equal(parseSensingMs('2026-09-16T21:34:00+00:00'), asOfMs);
  assert.equal(parseSensingMs('not-a-time'), null);
});

test('sensor normalization drops unlocated rows and reads active status', () => {
  const sensors = normalizeSensors([
    sensorRow(1),
    sensorRow(2, { status: 'I' }),
    sensorRow(3, { latitude: null, longitude: null, location: null }),
    { location_id: 4, latitude: 999, longitude: 10 },
  ]);
  assert.deepEqual([...sensors.keys()], [1, 2]);
  assert.equal(sensors.get(1).listedActive, true);
  assert.equal(sensors.get(2).listedActive, false);
});

test('intensity tiers map totals to the graduated ramp', () => {
  assert.equal(intensityTier(10), 0);
  assert.equal(intensityTier(50), 0);
  assert.equal(intensityTier(51), 1);
  assert.equal(intensityTier(600), 2);
  assert.equal(intensityTier(5000), 3);
  assert.equal(intensityTier(null), null);
});

test('merge marks reporting vs unknown, keeps genuine zeros, drops inactive', () => {
  const asOfMs = Date.parse('2026-09-16T21:34:00Z');
  const sensors = normalizeSensors([
    sensorRow(1), // busy
    sensorRow(2), // genuine zero in window
    sensorRow(3), // no row in window → unknown
    sensorRow(9, { status: 'I' }), // listed inactive → dropped
  ]);
  const counts = normalizeCounts([
    { location_id: 1, total: 120 },
    { location_id: 2, total: 0 },
  ]);
  const records = mergePedestrianRecords(sensors, counts, { asOfMs });
  const byId = Object.fromEntries(records.map((r) => [r.locationId, r]));
  assert.equal(records.length, 3, 'listed-inactive sensor is excluded');
  assert.equal(byId[1].windowTotal, 120);
  assert.equal(byId[1].hasRecent, true);
  assert.equal(byId[1].tier, 1);
  assert.equal(byId[1].asOfMs, asOfMs);
  // A genuine zero from a reading in the window is a real count, not "unknown".
  assert.equal(byId[2].windowTotal, 0);
  assert.equal(byId[2].hasRecent, true);
  // A sensor with no row in the window is unknown — never a zero.
  assert.equal(byId[3].hasRecent, false);
  assert.equal(byId[3].windowTotal, null);
  assert.equal(byId[3].tier, null);
  assert.equal(pedestrianCountLabel(byId[3]), 'NO RECENT COUNT');
  assert.equal(pedestrianCountLabel(byId[1]), 'LAST 15 MIN · 120');
});

test('the source anchors the window to the feed latest and caches sensors', async () => {
  let sensorCalls = 0;
  let countCalls = 0;
  let latestCalls = 0;
  const feedLatest = '2026-09-16T21:34:00+00:00';
  let capturedWhere = null;
  const source = createMelbournePedestrianSource({
    fetchImpl: async (url) => {
      if (url.includes('sensor-locations')) {
        sensorCalls += 1;
        return {
          ok: true,
          json: async () => ({ results: [sensorRow(1), sensorRow(2)] }),
        };
      }
      if (url.includes('order_by=sensing_datetime')) {
        latestCalls += 1;
        return {
          ok: true,
          json: async () => ({ results: [{ sensing_datetime: feedLatest }] }),
        };
      }
      countCalls += 1;
      capturedWhere = decodeURIComponent(url);
      return {
        ok: true,
        json: async () => ({ results: [{ location_id: 1, total: 300 }] }),
      };
    },
  });
  const first = await source.getSnapshot();
  // Window anchored to the feed's latest reading, not wall clock.
  assert.match(capturedWhere, /sensing_datetime>="2026-09-16T21:19:00\.000Z"/);
  assert.equal(first.length, 2);
  const s1 = first.find((r) => r.locationId === 1);
  assert.equal(s1.windowTotal, 300);
  assert.equal(s1.hasRecent, true);
  assert.equal(s1.asOfMs, Date.parse(feedLatest));
  assert.equal(first.find((r) => r.locationId === 2).hasRecent, false);
  await source.getSnapshot();
  assert.equal(sensorCalls, 1, 'sensor locations are cached across polls');
  assert.equal(latestCalls, 2, 'feed anchor refetched every poll');
  assert.equal(countCalls, 2, 'counts refetched every poll');
});

test('a malformed payload is a failure, not an authoritative empty map', async () => {
  const source = createMelbournePedestrianSource({
    fetchImpl: async (url) =>
      url.includes('sensor-locations')
        ? { ok: true, json: async () => ({ nope: true }) }
        : { ok: true, json: async () => ({ results: [] }) },
  });
  await assert.rejects(() => source.getSnapshot(), /Malformed Melbourne/);
});

function viewer() {
  let ds = null;
  return {
    get ds() {
      return ds;
    },
    dataSources: { add: (v) => (ds = v), remove() {} },
  };
}

test('the layer renders reporting sensors, names delay, answers the analyst', async () => {
  const asOfMs = Date.now() - 40 * 60000; // 40 min behind → delay surfaced
  const layer = createPedestriansLayer({
    source: {
      label: 'City of Melbourne · Pedestrian Counting System',
      async getSnapshot() {
        return [
          {
            id: 'ped:1',
            locationId: 1,
            lat: -37.81,
            lon: 144.96,
            description: 'Bourke St Mall',
            windowMinutes: 15,
            windowTotal: 340,
            hasRecent: true,
            tier: 2,
            asOfMs,
          },
          {
            id: 'ped:2',
            locationId: 2,
            lat: -37.82,
            lon: 144.97,
            description: 'Quiet Lane',
            windowMinutes: 15,
            windowTotal: null,
            hasRecent: false,
            tier: null,
            asOfMs,
          },
        ];
      },
    },
  });
  const v = viewer();
  layer.init(v);
  layer.enable();
  assert.equal(await layer.update(), true);
  const entities = v.ds.entities.values;
  assert.equal(entities.length, 2, 'reporting and unknown sensors both draw');
  assert.match(
    v.ds.entities.getById('pedestrian:1').label.text.getValue(),
    /BOURKE ST MALL\nLAST 15 MIN · 340/,
  );
  assert.match(
    v.ds.entities.getById('pedestrian:2').label.text.getValue(),
    /NO RECENT COUNT/,
  );
  const analyst = layer.getAnalystRecords();
  assert.equal(analyst.length, 1, 'only reporting sensors answer the analyst');
  assert.equal(analyst[0].pedestriansWindow, 340);
  assert.equal(layer.getStats().countLabel, '1 reporting');
  assert.match(layer.getStats().loadingLabel, /Feed ~\d+ min behind/);
  assert.match(layer.getRowControls().legend[0].blurb, /min old \(it publishes in bursts\)/);
  layer.disable();
  assert.deepEqual(layer.getAnalystRecords(), []);
  layer.destroy(v);
});

test('a failed refresh keeps the previous readings and reports the error', async () => {
  let fail = false;
  const layer = createPedestriansLayer({
    source: {
      async getSnapshot() {
        if (fail) throw new Error('Melbourne Open Data HTTP 503');
        return [
          {
            id: 'ped:1',
            locationId: 1,
            lat: -37.81,
            lon: 144.96,
            description: 'Bourke St Mall',
            windowMinutes: 15,
            windowTotal: 200,
            hasRecent: true,
            tier: 1,
            asOfMs: Date.now(),
          },
        ];
      },
    },
  });
  const v = viewer();
  layer.init(v);
  layer.enable();
  assert.equal(await layer.update(), true);
  fail = true;
  assert.equal(await layer.update(), false);
  assert.equal(v.ds.entities.values.length, 1, 'warm readings survive an outage');
  assert.match(layer.getStats().error, /HTTP 503/);
  layer.destroy(v);
});
