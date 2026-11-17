import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia } from 'pinia';
import { installEntityContext } from './entityContextBridge.js';
import { useEntityCardStore } from './stores/entityCard.js';
import { fakeInput } from '../input/testDoubles.mjs';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../data/pickRegistry.js';

// A coarse tap that misses everything exactly finds a fire within the shared
// touch window. On open map Context names it; under a quake card or label the
// card takes the tap, since the fire layer acts only on exact hits; an exact
// hit on the fire is the fire's, under a card or not.
test('Context leaves a near-missed exact-only item to a card painted over it', (t) => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  t.after(() => {
    if (previous) globalThis.matchMedia = previous;
    else delete globalThis.matchMedia;
  });
  const fire = { set: 'test-fires:1', id: 'fire:1' };
  registerPickOwner('test-fires', (id) => id === fire.id);
  t.after(() => unregisterPickOwner('test-fires'));
  let exact = false;
  const viewer = {
    scene: {
      pick: () => (exact ? { id: fire } : null),
      drillPick: () => [{ id: fire }],
    },
  };
  const input = fakeInput(viewer);
  let cardOnTop = false;
  const pinia = createPinia();
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => ({
      isEnabled: () => true,
      layers: new Map(),
      getAll: () => [],
    }),
    pinia,
    overlayHit: () =>
      cardOnTop ? { sourceId: 'earthquake-card', entryId: 'q' } : null,
  });
  t.after(() => {
    disconnect();
    input.destroy();
  });
  const store = useEntityCardStore(pinia);
  const named = [];
  store.select = (identity) => named.push(identity.id);
  const tap = () => {
    named.length = 0;
    input.click();
    return [...named];
  };
  assert.deepEqual(tap(), ['fire:1'], 'open map: Context names the fire');
  cardOnTop = true;
  assert.deepEqual(tap(), [], 'under a card: the card keeps the tap');
  exact = true;
  assert.deepEqual(tap(), ['fire:1'], 'an exact hit is the fire’s');
});

// Every card layer acts over a passive owner's pick (a directions route), so
// Context leaves an exact route hit under a card to that card, and names it on
// open map as before.
test('Context leaves an exact passive route under a card to the card', (t) => {
  const route = { set: 'test-route:1', id: 'route:line' };
  registerPickOwner('test-route', (id) => id.startsWith('route:'), {
    passive: true,
  });
  t.after(() => unregisterPickOwner('test-route'));
  const viewer = { scene: { pick: () => ({ id: route }) } };
  const input = fakeInput(viewer);
  let cardOnTop = false;
  const pinia = createPinia();
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => ({
      isEnabled: () => true,
      layers: new Map(),
      getAll: () => [],
    }),
    pinia,
    overlayHit: () =>
      cardOnTop ? { sourceId: 'earthquake-card', entryId: 'q' } : null,
  });
  t.after(() => {
    disconnect();
    input.destroy();
  });
  const named = [];
  useEntityCardStore(pinia).select = (identity) => named.push(identity.id);
  input.click();
  assert.deepEqual(named, ['route:line'], 'open map: Context names the route');
  cardOnTop = true;
  input.click();
  assert.deepEqual(named, ['route:line'], 'under a card: the card keeps it');
});
