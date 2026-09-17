import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateTrack, createAnomalyEngine } from './anomalyEngine.js';

const MIN = 60_000;
const T0 = 1_000_000_000;

function fix(t, lat, lon, extra = {}) {
  return { t, lat, lon, heightM: 9000, headingDeg: 90, speed: 200, ...extra };
}

test('rules fire on the right shapes and stay quiet otherwise', () => {
  // Stopped vessel: moving 10 min ago, still for the last 5.
  const vessel = [
    fix(T0 - 11 * MIN, 30, -90, { speed: 5, heightM: 0 }),
    fix(T0 - 8 * MIN, 30.02, -90, { speed: 4, heightM: 0 }),
    fix(T0 - 5 * MIN, 30.03, -90, { speed: 0.1, heightM: 0 }),
    fix(T0 - 3 * MIN, 30.03, -90, { speed: 0.05, heightM: 0 }),
    fix(T0, 30.03, -90, { speed: 0.02, heightM: 0 }),
  ];
  const stopped = evaluateTrack('ais-live-vessels', vessel, { now: T0 });
  assert.deepEqual(stopped.map((a) => a.kind), ['stopped_vessel']);

  // Rapid descent: 2600 m in 60 s (emergency descent); a normal 1000 m/min descent stays quiet.
  const descent = [fix(T0 - 2 * MIN, 30, -90, { heightM: 7000 }), fix(T0 - MIN, 30.05, -90, { heightM: 6800 }), fix(T0, 30.1, -90, { heightM: 4200 })];
  assert.deepEqual(evaluateTrack('flights', descent, { now: T0 }).map((a) => a.kind), ['rapid_descent']);
  const normal = [fix(T0 - MIN, 30, -90, { heightM: 6000 }), fix(T0, 30.05, -90, { heightM: 5000 })];
  assert.deepEqual(evaluateTrack('flights', normal, { now: T0 }), []);
  // A 30 s poll that carried 110 s of real travel (stale source data) is not a jump.
  const stale = [fix(T0 - 30_000, 30, -90), fix(T0, 30, -89.7)];
  assert.deepEqual(evaluateTrack('flights', stale, { now: T0 }), []);

  // Orbiting: heading sweeps 3 full turns with almost no displacement.
  const orbit = [];
  for (let i = 0; i < 12; i++)
    orbit.push(fix(T0 - (11 - i) * 45_000, 30 + 0.01 * Math.sin(i), -90 + 0.01 * Math.cos(i), { headingDeg: (i * 100) % 360 }));
  assert.deepEqual(evaluateTrack('flights', orbit, { now: T0 }).map((a) => a.kind), ['orbiting']);

  // Position jump: 200 km in 30 s.
  const jump = [fix(T0 - 30_000, 30, -90), fix(T0, 31.8, -90)];
  assert.equal(evaluateTrack('flights', jump, { now: T0 })[0].kind, 'position_jump');

  // Went dark: steady vessel, silent for 9 minutes.
  const dark = [];
  for (let i = 0; i < 6; i++) dark.push(fix(T0 - 15 * MIN + i * MIN, 30, -90, { speed: 4, heightM: 0 }));
  assert.ok(evaluateTrack('ais-live-vessels', dark, { now: T0 }).some((a) => a.kind === 'went_dark'));

  // Ordinary cruise: nothing.
  const cruise = [fix(T0 - 2 * MIN, 30, -90), fix(T0 - MIN, 30, -89.9), fix(T0, 30, -89.8)];
  assert.deepEqual(evaluateTrack('flights', cruise, { now: T0 }), []);
  assert.deepEqual(evaluateTrack('flights', [], { now: T0 }), []);
});

test('the engine dedupes per entity with a cooldown, keeps a ledger and speaks by severity', () => {
  let now = T0;
  const listeners = new Set();
  const dataManager = { subscribeActivity: (cb) => (listeners.add(cb), () => listeners.delete(cb)) };
  const tracks = new Map([
    ['flights:a1', [fix(T0 - 30_000, 30, -90), fix(T0, 31.8, -90)]],
  ]);
  const history = {
    entitiesAt: () => [{ layerId: 'flights', id: 'a1', label: 'UAL1' }],
    trackOf: (layer, id) => tracks.get(`${layer}:${id}`) || [],
  };
  const spoken = [];
  const store = new Map();
  const engine = createAnomalyEngine({
    dataManager,
    getHistory: () => history,
    onAnomaly: (a) => spoken.push(a),
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    now: () => now,
  });
  engine.start();
  for (const cb of listeners) cb({ type: 'data-updated', layerId: 'flights' });
  assert.equal(spoken.length, 1);
  assert.match(spoken[0].text, /impossible position jump: UAL1/);
  assert.equal(spoken[0].spoken, true, 'high severity is spoken');
  for (const cb of listeners) cb({ type: 'data-updated', layerId: 'flights' });
  assert.equal(spoken.length, 1, 'cooldown suppresses the repeat');
  now += 16 * MIN;
  for (const cb of listeners) cb({ type: 'data-updated', layerId: 'flights' });
  assert.equal(spoken.length, 2, 'fires again after the cooldown');
  assert.equal(engine.list({ minutes: 60 }).length, 2);
  assert.equal(engine.list({ kind: 'orbiting' }).length, 0);
  engine.setSpoken(false);
  assert.equal(engine.spoken, false);
  assert.ok(store.get('gev:voice-anomalies:v1').includes('position_jump'));
  engine.destroy();
});

test('speech is limited to nearby anomalies and a rate budget; the ledger keeps all', () => {
  const now = T0;
  const listeners = new Set();
  const dataManager = { subscribeActivity: (cb) => (listeners.add(cb), () => listeners.delete(cb)) };
  const ids = ['a1', 'a2', 'a3', 'far'];
  const history = {
    entitiesAt: () => ids.map((id) => ({ layerId: 'flights', id, label: id.toUpperCase() })),
    trackOf: (layer, id) => [fix(T0 - 30_000, id === 'far' ? 50 : 30, -90), fix(T0, id === 'far' ? 51.8 : 31.8, -90)],
  };
  const out = [];
  const engine = createAnomalyEngine({
    dataManager,
    getHistory: () => history,
    onAnomaly: (a) => out.push(a),
    storage: { getItem: () => null, setItem: () => {} },
    now: () => now,
    isRelevant: (r) => r.lat < 40,
    speakMinGapMs: 0,
    speakBudget: { count: 2, perMs: 10 * MIN },
  });
  engine.start();
  for (const cb of listeners) cb({ type: 'data-updated', layerId: 'flights' });
  assert.equal(out.length, 4, 'every anomaly reaches the ledger');
  assert.deepEqual(out.map((a) => a.nearby), [true, true, true, false]);
  assert.deepEqual(out.map((a) => a.spoken), [true, true, false, false], 'budget of two, far one silent');
  engine.destroy();
});
