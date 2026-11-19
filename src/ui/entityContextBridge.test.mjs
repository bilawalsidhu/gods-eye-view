import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia } from 'pinia';
import { installEntityContext } from './entityContextBridge.js';
import { useEntityCardStore } from './stores/entityCard.js';
import { fakeInput } from '../input/testDoubles.mjs';
import {
  registerPickOwner,
  setClickCardHitTest,
  unregisterPickOwner,
} from '../data/pickRegistry.js';

// The card or label painted on top takes the click: Context names nothing
// under it, exact or nearby, an acting owner's item or a passive one, and
// keeps its own card. On open map it names what the click found.
test('Context names nothing under a card painted on top, and keeps its card', (t) => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  t.after(() => {
    if (previous) globalThis.matchMedia = previous;
    else delete globalThis.matchMedia;
  });
  const fire = { set: 'test-fires:1', id: 'fire:1' };
  const plane = { set: 'test-planes:1', id: 'plane:1' };
  const route = { set: 'test-route:1', id: 'route:line' };
  registerPickOwner('test-fires', (id) => id === fire.id);
  registerPickOwner('test-planes', (id) => id === plane.id);
  registerPickOwner('test-route', (id) => id.startsWith('route:'));
  let cardOnTop = false;
  // The card on top at a click, as the host answers the pick registry.
  setClickCardHitTest(() =>
    cardOnTop ? { sourceId: 'earthquake-card', entryId: 'q' } : null,
  );
  t.after(() => {
    setClickCardHitTest(null);
    unregisterPickOwner('test-fires');
    unregisterPickOwner('test-planes');
    unregisterPickOwner('test-route');
  });
  let exact = null;
  let near = null;
  const viewer = {
    scene: {
      pick: () => (exact ? { id: exact } : null),
      drillPick: () => (near ? [{ id: near }] : []),
    },
  };
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => ({
      isEnabled: () => true,
      layers: new Map(),
      getAll: () => [],
    }),
    pinia,
  });
  t.after(() => {
    disconnect();
    input.destroy();
  });
  const store = useEntityCardStore(pinia);
  const named = [];
  let clears = 0;
  store.select = (identity) => named.push(identity.id);
  store.clear = () => clears++;
  const tap = (hitExact, hitNear) => {
    exact = hitExact;
    near = hitNear;
    named.length = 0;
    input.click();
    return [...named];
  };
  assert.deepEqual(tap(null, fire), ['fire:1'], 'open map: a near fire');
  assert.deepEqual(tap(route, null), ['route:line'], 'open map: a route');
  cardOnTop = true;
  assert.deepEqual(tap(null, fire), [], 'under a card: a near fire');
  assert.deepEqual(tap(fire, fire), [], 'under a card: an exact fire');
  assert.deepEqual(tap(plane, plane), [], 'under a card: an aircraft');
  assert.deepEqual(tap(route, null), [], 'under a card: a route');
  const cleared = clears;
  tap(null, null);
  assert.equal(clears, cleared, 'a card over open map is not open map');
});
