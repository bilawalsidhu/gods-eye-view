import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeofenceEngine, pointInPolygon, insideFence, viewPolygon, hourKey } from './geofenceEngine.js';

function fakeDataManager(records) {
  const listeners = new Set();
  return {
    records,
    isEnabled: (id) => id in records,
    layers: { get: (id) => (id in records ? { module: { getAnalystRecords: () => records[id] } } : undefined) },
    subscribeActivity: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    publish: (layerId) => { for (const cb of listeners) cb({ type: 'data-updated', layerId }); },
  };
}
function storage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), map };
}

test('geometry helpers', () => {
  const square = [[0, 0], [0, 10], [10, 10], [10, 0]];
  assert.equal(pointInPolygon(5, 5, square), true);
  assert.equal(pointInPolygon(15, 5, square), false);
  assert.equal(insideFence({ shape: { kind: 'circle', latitude: 0, longitude: 0, km: 100 } }, 0.5, 0.5), true);
  assert.equal(insideFence({ shape: { kind: 'circle', latitude: 0, longitude: 0, km: 10 } }, 0.5, 0.5), false);
  const poly = viewPolygon({ lat: 30, lon: -90, alt: 50_000 });
  assert.equal(poly.length, 4);
  assert.ok(pointInPolygon(30, -90, poly));
  assert.match(hourKey(Date.UTC(2026, 8, 17, 13, 5)), /^2026-09-17T13Z$/);
});

test('fences count entries and exits per hour, alert on entry, and persist', () => {
  let now = Date.UTC(2026, 8, 17, 13, 0);
  const dm = fakeDataManager({ 'ais-live-vessels': [{ id: 'v1', name: 'ONE', lat: 30.001, lon: -90 }] });
  const alerts = [];
  const store = storage();
  const engine = createGeofenceEngine({
    dataManager: dm,
    getCamera: () => ({ lat: 30, lon: -90, alt: 20_000 }),
    onEnter: (e) => alerts.push(e.text),
    storage: store,
    now: () => now,
  });
  const fence = engine.add({ name: 'harbor', shape: { kind: 'circle', km: 5 }, layers: ['ais-live-vessels'], alertOnEnter: true });
  assert.equal(fence.insideNow['ais-live-vessels'].count, 1, 'baseline counted, not alerted');
  assert.equal(alerts.length, 0);
  dm.records['ais-live-vessels'].push({ id: 'v2', name: 'TWO', lat: 30.01, lon: -90 });
  now += 60_000;
  dm.publish('ais-live-vessels');
  assert.deepEqual(alerts, ['TWO entered harbor.']);
  dm.records['ais-live-vessels'].splice(0, 1); // ONE leaves
  now += 60_000;
  dm.publish('ais-live-vessels');
  const report = engine.describe(engine.find('harbor'));
  assert.equal(report.totals.entered, 1);
  assert.equal(report.totals.exited, 1);
  assert.equal(report.lastHours[0].hour, '2026-09-17T13Z');
  assert.equal(report.insideNow['ais-live-vessels'].count, 1);
  assert.equal(engine.outline(engine.find('harbor')).length, 12);
  const reloaded = createGeofenceEngine({ dataManager: dm, storage: store, now: () => now });
  assert.equal(reloaded.list()[0].name, 'harbor');
  assert.equal(reloaded.list()[0].totals.entered, 1);
  assert.equal(engine.remove('harbor'), 1);
  assert.throws(() => engine.add({ name: 'p', shape: { kind: 'polygon', points: [] }, layers: ['flights'] }), /at least 3/);
  engine.destroy();
});
