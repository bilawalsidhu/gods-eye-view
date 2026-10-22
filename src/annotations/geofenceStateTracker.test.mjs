import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeofenceStateTracker } from './geofenceStateTracker.js';
import { createGeofenceMonitor } from './geofenceMonitor.js';

test('tracker: outside->inside triggers entered once, duplicate inside no alert', () => {
  const t = createGeofenceStateTracker();
  assert.equal(t.update('a', false), null);
  assert.equal(t.update('a', true), 'entered');
  // duplicate inside -> no duplicate
  assert.equal(t.update('a', true), null);
  assert.equal(t.update('a', true), null);
  assert.equal(t.isInside('a'), true);
});

test('tracker: inside->outside triggers exited, re-enter triggers again', () => {
  const t = createGeofenceStateTracker();
  t.update('b', true);
  assert.equal(t.update('b', false), 'exited');
  assert.equal(t.update('b', false), null);
  assert.equal(t.update('b', true), 'entered');
});

test('tracker: first sighting seeds state without a transition', () => {
  const t = createGeofenceStateTracker();
  assert.equal(t.update('c', true), null);
  assert.equal(t.isInside('c'), true);
  assert.equal(t.update('c', false), 'exited');
  assert.equal(t.update('c', true), 'entered');
});

test('tracker: clear resets', () => {
  const t = createGeofenceStateTracker();
  t.update('a', true);
  t.clear();
  assert.equal(t.get('a'), null);
  // After a clear the next sighting is a first sighting again.
  assert.equal(t.update('a', true), null);
});

test('monitor: internal enter only on initial outside->inside, no duplicates', () => {
  const square = [
    { lon: 0, lat: 0 },
    { lon: 1, lat: 0 },
    { lon: 1, lat: 1 },
    { lon: 0, lat: 1 },
  ];
  let records = [{ icao24: 'a1', lat: 5, lon: 5 }]; // outside
  const fakeManager = {
    layers: new Map([
      [
        'flights',
        { enabled: true, module: { getAnalystRecords: () => records } },
      ],
    ]),
    subscribeActivity: () => () => {},
    subscribe: () => () => {},
  };
  const monitor = createGeofenceMonitor({
    getPolygon: () => square,
    dataManager: fakeManager,
  });

  let enterCount = 0;
  let enteredIds = [];
  monitor.onEnter((e) => {
    enterCount++;
    enteredIds.push(e.id ?? e._raw?.icao24);
  });

  // outside -> no enter
  monitor.evaluateAll();
  assert.equal(enterCount, 0);

  // move inside -> enter
  records = [{ icao24: 'a1', lat: 0.5, lon: 0.5 }];
  monitor.evaluateAll();
  assert.equal(enterCount, 1);

  // stay inside -> no duplicate
  monitor.evaluateAll();
  monitor.evaluateAll();
  assert.equal(enterCount, 1);

  // exit then re-enter -> second alert allowed
  records = [{ icao24: 'a1', lat: 5, lon: 5 }];
  monitor.evaluateAll();
  assert.equal(enterCount, 1);
  records = [{ icao24: 'a1', lat: 0.5, lon: 0.5 }];
  monitor.evaluateAll();
  assert.equal(enterCount, 2);

  monitor.destroy();
});

test('tracker: seed sets the baseline without a transition', () => {
  const t = createGeofenceStateTracker();
  t.seed('a', true);
  assert.equal(t.isInside('a'), true);
  // Already inside -> no entered, no duplicate
  assert.equal(t.update('a', true), null);
  assert.equal(t.update('a', false), 'exited');
  t.seed('b', false);
  assert.equal(t.isInside('b'), false);
  assert.equal(t.update('b', true), 'entered');
});

test('monitor: drawing over existing records seeds inside, fires nothing', async () => {
  const square = [
    { lon: 0, lat: 0 },
    { lon: 1, lat: 0 },
    { lon: 1, lat: 1 },
    { lon: 0, lat: 1 },
  ];
  // Static records already inside when the fence is drawn.
  const records = [
    { id: 'quake-1', lat: 0.5, lon: 0.5 },
    { id: 'fire-1', lat: 0.2, lon: 0.2 },
    { id: 'plane-1', lat: 5, lon: 5 },
  ];
  const calls = [];
  const fakeManager = {
    layers: new Map([
      [
        'mixed',
        { enabled: true, module: { getAnalystRecords: () => records } },
      ],
    ]),
    subscribeActivity: () => () => {},
    subscribe: () => () => {},
  };
  let polygon = null;
  const monitor = createGeofenceMonitor({
    getPolygon: () => polygon,
    dataManager: fakeManager,
    fetchImpl: async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return { ok: true };
    },
  });
  monitor.setWebhookUrl('https://example.com/breach');
  let enters = 0;
  monitor.onEnter(() => enters++);

  // Draw the fence over the existing records: silent baseline, no POST storm.
  polygon = square;
  monitor.notifyPolygonChanged();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(enters, 0);
  assert.equal(calls.length, 0);
  assert.equal(monitor.getInsideCount(), 2);
  assert.ok(monitor.isInside('mixed', 'quake-1'));

  // Later movement across the boundary still breaches.
  records[2].lat = 0.5;
  records[2].lon = 0.5;
  monitor.evaluateAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(enters, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].entityId, 'plane-1');

  monitor.destroy();
});

test('monitor: idle with no fence — pulls no records, keeps no state', () => {
  let pulls = 0;
  const fakeManager = {
    layers: new Map([
      [
        'flights',
        {
          enabled: true,
          module: {
            getAnalystRecords: () => {
              pulls += 1;
              return [{ icao24: 'A1', lat: 0.5, lon: 0.5 }];
            },
          },
        },
      ],
    ]),
    subscribeActivity: () => () => {},
    subscribe: () => () => {},
  };
  const monitor = createGeofenceMonitor({
    getPolygon: () => null,
    dataManager: fakeManager,
  });
  let evaluations = 0;
  monitor.subscribe((evt) => {
    if (evt?.type === 'evaluation') evaluations += 1;
  });
  monitor.evaluateAll();
  monitor.evaluateAll();
  assert.equal(pulls, 0);
  assert.equal(monitor.getTracker().size, 0);
  assert.equal(monitor.getInsideCount(), 0);
  // Nothing to report, so no evaluation noise either.
  assert.equal(evaluations, 0);
  monitor.destroy();
});

test('monitor: tracker entries for records that left the feed are pruned', () => {
  const square = [
    { lon: 0, lat: 0 },
    { lon: 1, lat: 0 },
    { lon: 1, lat: 1 },
    { lon: 0, lat: 1 },
  ];
  let records = [
    { icao24: 'A1', lat: 0.5, lon: 0.5 },
    { icao24: 'A2', lat: 5, lon: 5 },
  ];
  const fakeManager = {
    layers: new Map([
      [
        'flights',
        { enabled: true, module: { getAnalystRecords: () => records } },
      ],
    ]),
    subscribeActivity: () => () => {},
    subscribe: () => () => {},
  };
  const monitor = createGeofenceMonitor({
    getPolygon: () => square,
    dataManager: fakeManager,
  });
  monitor.evaluateAll();
  assert.equal(monitor.getTracker().size, 2);
  // A1 leaves the feed (landed, filtered, layer disabled): its state goes.
  records = [{ icao24: 'A2', lat: 5, lon: 5 }];
  monitor.evaluateAll();
  assert.equal(monitor.getTracker().size, 1);
  assert.equal(monitor.getTracker().get('flights:A1'), null);
  monitor.destroy();
});

test('monitor: records without any id are skipped, never alert', () => {
  const square = [
    { lon: 0, lat: 0 },
    { lon: 1, lat: 0 },
    { lon: 1, lat: 1 },
    { lon: 0, lat: 1 },
  ];
  // No icao24/mmsi/id/icao anywhere: untrackable, even mid-fence.
  const records = [
    { lat: 0.5, lon: 0.5 },
    { lat: 0.6, lon: 0.6, id: '' },
    { lat: 0.7, lon: 0.7, id: null },
  ];
  const fakeManager = {
    layers: new Map([
      [
        'mystery',
        { enabled: true, module: { getAnalystRecords: () => records } },
      ],
    ]),
    subscribeActivity: () => () => {},
    subscribe: () => () => {},
  };
  const monitor = createGeofenceMonitor({
    getPolygon: () => square,
    dataManager: fakeManager,
  });
  let enters = 0;
  monitor.onEnter(() => enters++);
  monitor.evaluateAll();
  // The records drift: with coordinate keys each update would re-alert.
  records[0].lat = 0.55;
  records[1].lon = 0.65;
  monitor.evaluateAll();
  assert.equal(enters, 0);
  assert.equal(monitor.getTracker().size, 0);
  assert.equal(monitor.getInsideCount(), 0);
  monitor.destroy();
});

test('monitor: updateEntity dedupes single position updates', () => {
  const square = [
    { lon: 0, lat: 0 },
    { lon: 1, lat: 0 },
    { lon: 1, lat: 1 },
    { lon: 0, lat: 1 },
  ];
  const monitor = createGeofenceMonitor({
    getPolygon: () => square,
    dataManager: {
      layers: new Map(),
      subscribeActivity: () => () => {},
      subscribe: () => () => {},
    },
  });
  let enters = 0;
  monitor.onEnter(() => enters++);
  assert.equal(monitor.updateEntity('flights', 'x1', 5, 5), null);
  assert.equal(enters, 0);
  assert.equal(monitor.updateEntity('flights', 'x1', 0.5, 0.5), 'entered');
  assert.equal(enters, 1);
  // duplicate
  assert.equal(monitor.updateEntity('flights', 'x1', 0.6, 0.6), null);
  assert.equal(enters, 1);
  monitor.destroy();
});

function layerRig() {
  const square = [
    { lon: 0, lat: 0 },
    { lon: 1, lat: 0 },
    { lon: 1, lat: 1 },
    { lon: 0, lat: 1 },
  ];
  const layers = new Map();
  const calls = [];
  const monitor = createGeofenceMonitor({
    getPolygon: () => square,
    dataManager: {
      layers,
      subscribeActivity: () => () => {},
      subscribe: () => () => {},
    },
    fetchImpl: async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return { ok: true };
    },
  });
  monitor.setWebhookUrl('https://example.com/breach');
  let enters = 0;
  monitor.onEnter(() => enters++);
  const setLayer = (key, records, enabled = true) =>
    layers.set(key, {
      enabled,
      module: { getAnalystRecords: () => records },
    });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { monitor, setLayer, calls, flush, enters: () => enters };
}

test('monitor: enabling a layer after the fence fires nothing for records already inside', async () => {
  const r = layerRig();
  r.monitor.notifyPolygonChanged();
  const quakes = [
    { id: 'q1', lat: 0.5, lon: 0.5 },
    { id: 'q2', lat: 0.2, lon: 0.7 },
  ];
  r.setLayer('earthquakes', quakes);
  r.monitor.evaluateAll();
  await r.flush();
  assert.equal(r.enters(), 0);
  assert.equal(r.calls.length, 0);
  assert.equal(r.monitor.getInsideCount(), 2);
  r.monitor.destroy();
});

test('monitor: toggling a layer off and on does not re-alert its records', async () => {
  const r = layerRig();
  const quakes = [
    { id: 'q1', lat: 0.5, lon: 0.5 },
    { id: 'q2', lat: 0.2, lon: 0.7 },
  ];
  r.setLayer('earthquakes', quakes);
  r.monitor.notifyPolygonChanged();
  r.setLayer('earthquakes', quakes, false);
  r.monitor.evaluateAll();
  r.setLayer('earthquakes', quakes, true);
  r.monitor.evaluateAll();
  await r.flush();
  assert.equal(r.enters(), 0);
  assert.equal(r.calls.length, 0);
  r.monitor.destroy();
});

test('monitor: a record that drops out of the feed and returns does not re-alert', async () => {
  const r = layerRig();
  const plane = { icao24: 'abc123', lat: 5, lon: 5 };
  const feed = [plane];
  r.setLayer('flights', feed);
  r.monitor.notifyPolygonChanged();
  // Genuine crossing still breaches once.
  plane.lat = 0.5;
  plane.lon = 0.5;
  r.monitor.evaluateAll();
  await r.flush();
  assert.equal(r.calls.length, 1);
  // Missing from one update (pruned), then back while still inside.
  feed.length = 0;
  r.monitor.evaluateAll();
  feed.push(plane);
  r.monitor.evaluateAll();
  await r.flush();
  assert.equal(r.enters(), 1);
  assert.equal(r.calls.length, 1);
  r.monitor.destroy();
});
