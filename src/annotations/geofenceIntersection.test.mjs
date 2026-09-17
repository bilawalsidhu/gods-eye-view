import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pointInPolygon,
  isInsideGeofence,
  filterInside,
  evaluateBatch,
} from './geofenceIntersection.js';
import { createGeofenceMonitor } from './geofenceMonitor.js';

const square = [
  { lon: 0, lat: 0 },
  { lon: 1, lat: 0 },
  { lon: 1, lat: 1 },
  { lon: 0, lat: 1 },
];

test('inside: point clearly inside', () => {
  assert.equal(pointInPolygon(0.5, 0.5, square), true);
  assert.equal(isInsideGeofence(0.5, 0.5, square), true);
});

test('outside: point clearly outside', () => {
  assert.equal(pointInPolygon(2, 2, square), false);
  assert.equal(isInsideGeofence(-1, 0.5, square), false);
});

test('boundary: point on edge counts as inside', () => {
  assert.equal(pointInPolygon(0, 0.5, square), true);
  assert.equal(pointInPolygon(0.5, 0, square), true);
  assert.equal(pointInPolygon(0, 0, square), true);
});

test('invalid: no polygon or too few vertices', () => {
  assert.equal(pointInPolygon(0.5, 0.5, []), false);
  assert.equal(pointInPolygon(0.5, 0.5, [{ lon: 0, lat: 0 }]), false);
  assert.equal(isInsideGeofence(0.5, 0.5, null), false);
});

test('antimeridian: polygon crossing 180 works', () => {
  const poly = [
    { lon: 179, lat: 0 },
    { lon: -179, lat: 0 },
    { lon: -179, lat: 1 },
    { lon: 179, lat: 1 },
  ];
  assert.equal(pointInPolygon(180, 0.5, poly), true);
  assert.equal(pointInPolygon(179.5, 0.5, poly), true);
  assert.equal(pointInPolygon(-179.5, 0.5, poly), true);
  assert.equal(pointInPolygon(170, 0.5, poly), false);
});

test('filterInside: mixed entities', () => {
  const entities = [
    { id: 'a', lon: 0.5, lat: 0.5 },
    { id: 'b', lon: 2, lat: 2 },
    { id: 'c', lon: 0.2, lat: 0.8 },
  ];
  const inside = filterInside(entities, square);
  assert.deepEqual(inside.map((e) => e.id).sort(), ['a', 'c']);
});

test('evaluateBatch: splits inside/outside, no polygon = all outside', () => {
  const entities = [
    { id: 'a', lon: 0.5, lat: 0.5 },
    { id: 'b', lon: 5, lat: 5 },
  ];
  const r1 = evaluateBatch(entities, square);
  assert.equal(r1.inside.length, 1);
  assert.equal(r1.outside.length, 1);
  const r2 = evaluateBatch(entities, null);
  assert.equal(r2.inside.length, 0);
  assert.equal(r2.outside.length, 2);
});

test('monitor: evaluates on demand and tracks enter/exit', () => {
  let polygon = [...square];
  const fakeManager = {
    layers: new Map([
      [
        'flights',
        {
          enabled: true,
          module: {
            getAnalystRecords: () => [
              { icao24: 'a1', lat: 0.5, lon: 0.5 },
              { icao24: 'b1', lat: 5, lon: 5 },
            ],
          },
        },
      ],
    ]),
    subscribeActivity: () => () => {},
    subscribe: () => () => {},
  };
  const monitor = createGeofenceMonitor({
    getPolygon: () => polygon,
    dataManager: fakeManager,
  });
  const r1 = monitor.evaluateAll();
  assert.equal(r1.inside.length, 1);
  assert.equal(r1.outside.length, 1);
  assert.equal(monitor.getInsideCount(), 1);

  // Move polygon so previous inside is now outside -> exit
  let transitions = [];
  monitor.subscribe((evt) => {
    if (evt.type === 'transition') transitions.push(evt);
  });
  polygon = [
    { lon: 10, lat: 10 },
    { lon: 11, lat: 10 },
    { lon: 11, lat: 11 },
    { lon: 10, lat: 11 },
  ];
  monitor.notifyPolygonChanged();
  const r2 = monitor.evaluateAll();
  assert.equal(r2.inside.length, 0);
  // exited should contain a1
  const lastTrans = transitions[transitions.length - 1];
  assert.ok(
    lastTrans.exited.some((e) => e.id === 'a1' || e._raw?.icao24 === 'a1'),
  );

  monitor.destroy();
});

test('monitor: evaluatePoint single check', () => {
  const monitor = createGeofenceMonitor({
    getPolygon: () => square,
    dataManager: {
      layers: new Map(),
      subscribeActivity: () => () => {},
      subscribe: () => () => {},
    },
  });
  assert.equal(monitor.evaluatePoint(0.5, 0.5), true);
  assert.equal(monitor.evaluatePoint(2, 2), false);
  monitor.destroy();
});

test('monitor: data-updated triggers evaluation', () => {
  let cb = null;
  const fakeManager = {
    layers: new Map([
      [
        'flights',
        {
          enabled: true,
          module: {
            getAnalystRecords: () => [{ icao24: 'x', lat: 0.5, lon: 0.5 }],
          },
        },
      ],
    ]),
    subscribeActivity: (fn) => {
      cb = fn;
      return () => {};
    },
    subscribe: () => () => {},
  };
  const monitor = createGeofenceMonitor({
    getPolygon: () => square,
    dataManager: fakeManager,
  });
  assert.equal(monitor.getInsideCount(), 0);
  cb({ type: 'data-updated', layerId: 'flights' });
  assert.equal(monitor.getInsideCount(), 1);
  monitor.destroy();
});
