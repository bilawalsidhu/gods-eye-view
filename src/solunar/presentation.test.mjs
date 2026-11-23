import assert from 'node:assert/strict';
import test from 'node:test';
import { createSolunarPanel, HOUR12_STORAGE_KEY } from './panel.js';
import { dayCard } from './format.js';

test('the card publishes the spot and week, handles controls and disconnects', () => {
  const store = {
    panel: null,
    controls: null,
    publish(value) {
      this.panel = value;
    },
    connect(value) {
      this.controls = value;
    },
  };
  const values = new Map();
  let center = 0;
  const owner = createSolunarPanel({
    store,
    now: () => Date.UTC(2026, 10, 2, 18),
    storage: {
      getItem: (key) => values.get(key),
      setItem: (key, value) => values.set(key, value),
    },
    onUseCenter: () => center++,
  });
  assert.equal(store.panel.spot, null);
  assert.equal(owner.setSpot(33.05, -95.1), true);
  assert.equal(store.panel.spot.zone, 'America/Chicago');
  assert.equal(store.panel.days.length, 7);
  const first = store.panel.days[0];
  assert.equal(first.date, '2026-11-02');
  assert.deepEqual(first.moonrise, []);
  const card = dayCard(
    first,
    store.panel.spot.zone,
    true,
    store.panel.rule.maxStars,
  );
  assert.equal(card.times.find((row) => row.key === 'moonrise').value, 'none');
  store.controls.setHour12(false);
  assert.equal(values.get(HOUR12_STORAGE_KEY), '24');
  assert.equal(store.panel.hour12, false);
  store.controls.useCenter();
  assert.equal(center, 1);
  assert.equal(owner.setSpot(NaN, 4), false);
  assert.equal(owner.getSpot().latDeg, 33.05);
  owner.destroy();
  assert.equal(store.panel, null);
  assert.equal(store.controls, null);
});
