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

test('tracker: unknown->inside counts as entered (initial transition)', () => {
  const t = createGeofenceStateTracker();
  assert.equal(t.update('c', true), 'entered');
});

test('tracker: clear resets', () => {
  const t = createGeofenceStateTracker();
  t.update('a', true);
  t.clear();
  assert.equal(t.get('a'), null);
  assert.equal(t.update('a', true), 'entered');
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
