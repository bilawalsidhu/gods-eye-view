import assert from 'node:assert/strict';
import test from 'node:test';
import { createPatrolEngine, diffPasses, composeBriefing } from './patrolEngine.js';

function fakeDataManager(records) {
  return {
    records,
    isEnabled: (id) => id in records,
    layers: { get: (id) => (id in records ? { module: { getAnalystRecords: () => records[id] } } : undefined) },
  };
}
function storage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), map };
}

test('pass diffs classify arrivals, departures, stops and altitude swings', () => {
  const previous = new Map([
    ['a', { id: 'a', label: 'A', speedKts: 10 }],
    ['b', { id: 'b', label: 'B', speedKts: 8 }],
  ]);
  const current = new Map([
    ['a', { id: 'a', label: 'A', speedKts: 0.2 }],
    ['c', { id: 'c', label: 'C', speedKts: 12 }],
  ]);
  const diff = diffPasses(previous, current, 'ais-live-vessels');
  assert.deepEqual(diff.arrived.map((r) => r.id), ['c']);
  assert.deepEqual(diff.departed.map((r) => r.id), ['b']);
  assert.deepEqual(diff.stopped.map((r) => r.id), ['a']);
  const air = diffPasses(new Map([['x', { id: 'x', altitudeM: 10000 }]]), new Map([['x', { id: 'x', altitudeM: 5000 }]]), 'flights');
  assert.equal(air.descended.length, 1);
  const text = composeBriefing({ name: 'Gulf' }, [{ layerId: 'ais-live-vessels', count: 2, first: false, diff }], {
    anomalies: [{ text: 'stopped vessel: A, still.' }],
  });
  assert.match(text, /^Patrol Gulf: 2 vessels in range, 1 new \(C\), 1 left, 1 stopped \(A\)\. 1 anomaly: stopped vessel: A, still\.$/);
});

test('a patrol briefs on creation, diffs on the next pass, runs on its interval and persists', () => {
  let now = 10_000_000;
  const dm = fakeDataManager({
    'ais-live-vessels': [
      { id: '1', name: 'ONE', lat: 30.01, lon: -90, speedKts: 9 },
      { id: '2', name: 'TWO', lat: 30.02, lon: -90, speedKts: 6 },
    ],
  });
  const spoken = [];
  const timers = [];
  const store = storage();
  const engine = createPatrolEngine({
    dataManager: dm,
    getCamera: () => ({ lat: 30, lon: -90, alt: 100_000 }),
    getAnomalies: () => [],
    speak: (t) => spoken.push(t),
    storage: store,
    now: () => now,
    setTimer: (fn) => (timers.push(fn), 1),
    clearTimer: () => {},
  });
  const created = engine.add({ name: 'Gulf ships', layers: ['ais-live-vessels'], scope: { kind: 'radius', km: 50 }, intervalMinutes: 20 });
  assert.match(created.firstBriefing, /Patrol Gulf ships: 2 vessels in range on the first pass\./);
  assert.equal(spoken.length, 1);
  dm.records['ais-live-vessels'].push({ id: '3', name: 'THREE', lat: 30.03, lon: -90, speedKts: 11 });
  dm.records['ais-live-vessels'][0].speedKts = 0.1;
  now += 10 * 60_000;
  timers[0]();
  assert.equal(spoken.length, 1, 'not due yet');
  now += 11 * 60_000;
  timers[0]();
  assert.equal(spoken.length, 2);
  assert.match(spoken[1], /3 vessels in range, 1 new \(THREE\), 1 stopped \(ONE\)\./);
  assert.equal(engine.list()[0].lastBriefing, spoken[1]);
  assert.equal(engine.ledger('gulf').length, 2);
  const reloaded = createPatrolEngine({ dataManager: dm, storage: store, speak: () => {}, now: () => now });
  assert.equal(reloaded.list()[0].name, 'Gulf ships');
  assert.equal(engine.stop('gulf'), 1);
  assert.equal(engine.list().length, 0);
});
