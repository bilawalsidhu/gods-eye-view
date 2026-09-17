import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalMemory, MEMORY_STORAGE_KEY } from './localMemory.js';

function storage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

test('places persist, match loosely, and survive a reload', () => {
  const store = storage();
  let clock = 1_000_000;
  const memory = createLocalMemory({ storage: store, now: () => clock });
  const camera = { lat: 30.27, lon: -97.74, alt: 600, heading: 10, pitch: -40, roll: 0 };
  assert.equal(memory.rememberPlace('Home', camera).name, 'Home');
  clock += 60_000;
  memory.rememberPlace('the office', { lat: 1, lon: 2, alt: 3 });
  assert.equal(memory.recallPlace('home').lat, 30.27);
  assert.equal(memory.recallPlace('my home').lat, 30.27);
  assert.equal(memory.recallPlace('office').lon, 2);
  assert.equal(memory.recallPlace('marina'), null);
  assert.deepEqual(
    memory.listPlaces().map((p) => p.name),
    ['the office', 'Home'],
  );
  const reloaded = createLocalMemory({ storage: store, now: () => clock });
  assert.equal(reloaded.recallPlace('home').alt, 600);
  assert.equal(reloaded.forgetPlace('home'), true);
  assert.equal(reloaded.forgetPlace('home'), false);
  assert.ok(store.map.get(MEMORY_STORAGE_KEY).includes('office'));
  assert.equal(memory.rememberPlace('', camera), null);
});

test('recent targets dedupe, cap, and summarize with ages', () => {
  let clock = 10 * 60_000;
  const memory = createLocalMemory({ storage: storage(), now: () => clock });
  memory.noteTarget({ kind: 'aircraft', id: 'abc123', label: 'UAL1' });
  clock += 5 * 60_000;
  memory.noteTarget({ kind: 'vessel', id: '3660', label: 'EVER GIVEN' });
  memory.noteTarget({ kind: 'aircraft', id: 'abc123', label: 'UAL1' });
  assert.deepEqual(
    memory.recentTargets().map((r) => r.id),
    ['abc123', '3660'],
    'latest first, no duplicates',
  );
  assert.equal(memory.recentTargets('vessel').length, 1);
  for (let i = 0; i < 20; i++) memory.noteTarget({ kind: 'place', id: null, label: `p${i}` });
  assert.equal(memory.recentTargets().length, 12);
  const summary = memory.summary();
  assert.deepEqual(summary.places, []);
  assert.equal(summary.recent.length, 6);
  assert.match(summary.recent[0], /place "p19" just now/);
});
