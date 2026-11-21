import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia } from 'pinia';
import { useEntityCardStore } from './entityCard.js';

/**
 * A vessels layer whose one vessel can leave its feed, and a shell that
 * records what the card asks of it.
 */
function setup({ found = true } = {}) {
  const vessel = {
    id: 'v1',
    name: 'ARCADIA',
    lat: 1,
    lon: 10,
    reference: 'vessel:v1',
  };
  let inFeed = true;
  const asked = [];
  const module = {
    getAnalystRecords: () => (inFeed ? [{ ...vessel }] : []),
    referenceOf: (id) => (id === 'v1' && inFeed ? vessel.reference : null),
    async locate(id, { reference }) {
      asked.push({ id, reference });
      return found
        ? {
            status: 'found',
            lat: 5,
            lon: 50,
            altitudeM: null,
            observedAtMs: 1_000,
            atMs: 61_000,
          }
        : { status: 'none' };
    },
  };
  const dataManager = {
    isEnabled: () => true,
    layers: new Map([['ais-live-vessels', { module }]]),
    getAll: () => [],
  };
  const shell = {
    flown: [],
    followed: [],
    reselected: [],
    visible: true,
    dataManager: () => dataManager,
    openPanel() {},
    flyTo(card) {
      shell.flown.push([card.lat, card.lon]);
    },
    follow(card) {
      shell.followed.push(card.key);
    },
    reselect(card, options) {
      shell.reselected.push([card.identity.id, options.follow]);
    },
    onScreen: () => shell.visible,
    canFollow: () => false,
  };
  const store = useEntityCardStore(createPinia());
  store.connect(shell);
  return {
    store,
    shell,
    asked,
    leave: () => (inFeed = false),
    come: () => (inFeed = true),
  };
}

test('a vessel out of its feed is looked up, shown where it was and flown to', async (t) => {
  const { store, shell, asked, leave, come } = setup();
  t.after(() => store.clear());
  assert.equal(store.select({ layerId: 'ais-live-vessels', id: 'v1' }), true);
  assert.equal(store.away, false, 'on screen and in its feed');

  leave();
  store.refresh();
  assert.equal(store.lost, true);
  assert.equal(store.away, true, 'out of its feed: the card offers to find it');

  await store.locate();
  assert.deepEqual(
    asked,
    [{ id: 'v1', reference: 'vessel:v1' }],
    'by the reference it had',
  );
  assert.equal(store.card.lat, 5);
  assert.equal(store.card.lon, 50);
  assert.deepEqual(shell.flown, [[5, 50]]);
  assert.equal(store.located.observedAtMs, 1_000);
  assert.equal(store.finding, 'idle');

  come();
  store.refresh();
  assert.equal(store.lost, false, 'back in its feed');
  assert.equal(store.located, null);
  assert.deepEqual(
    shell.reselected,
    [['v1', false]],
    'its layer selects it again',
  );
});

test('a vessel with no reading at the time says so and stays put', async (t) => {
  const { store, shell, leave } = setup({ found: false });
  t.after(() => store.clear());
  store.select({ layerId: 'ais-live-vessels', id: 'v1' });
  leave();
  store.refresh();
  await store.locate();
  assert.equal(store.finding, 'none');
  assert.deepEqual(shell.flown, [], 'the camera stays');
  assert.equal(store.card.lat, 1, 'the card keeps its last reading');
});

test('an item in its feed but off screen is flown to without a lookup', async (t) => {
  const { store, shell, asked } = setup();
  t.after(() => store.clear());
  store.select({ layerId: 'ais-live-vessels', id: 'v1' });
  shell.visible = false;
  store.refresh();
  assert.equal(store.away, true, 'off screen');
  await store.locate();
  assert.deepEqual(asked, []);
  assert.deepEqual(shell.flown, [[1, 10]]);
});

test('an item the camera follows is never away, wherever its last reading is', (t) => {
  const { store, shell } = setup();
  t.after(() => store.clear());
  store.select({ layerId: 'ais-live-vessels', id: 'v1' });
  shell.visible = false;
  store.following = store.card.key;
  store.refresh();
  assert.equal(store.away, false);
});

test('a lookup still running when the item comes back is dropped', async (t) => {
  const { store, shell, leave, come } = setup();
  t.after(() => store.clear());
  store.select({ layerId: 'ais-live-vessels', id: 'v1' });
  leave();
  store.refresh();
  const pending = store.locate();
  come();
  store.refresh();
  await pending;
  assert.equal(store.lost, false);
  assert.equal(store.located, null, 'no old reading on a live card');
  assert.equal(store.card.lat, 1, 'the card keeps its live position');
  assert.deepEqual(shell.flown, [], 'the camera stays');
});
