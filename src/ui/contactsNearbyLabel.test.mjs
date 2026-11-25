import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { useEntityCardStore } from './stores/entityCard.js';
import { createControls } from '../layers/awareness/controls.js';

test('Nearby shows a renamed stationary Contacts subject without a pan', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  // Real Contacts controls: a stationary subject whose label is enriched after selection
  // (awareness/subject.js replaces subject.label without re-evaluating results).
  const layerState = {
    enabled: true,
    passive: false,
    subject: {
      layerId: 'flights',
      id: 'abc123',
      label: 'ABC123',
      position: { x: 6378137, y: 0, z: 0 },
    },
    results: {
      evaluatedAt: 1,
      radiusM: 250_000,
      cohorts: [{ id: 'flights', summary: { count: 1 } }],
    },
  };
  const { methods } = createControls({
    state: layerState,
    services: {},
    parts: { dependencies: {} },
    source: {},
  });
  const row = {
    id: 'military-awareness',
    name: 'Contacts',
    enabled: true,
    module: methods,
  };
  Object.defineProperty(row, 'stats', { get: () => methods.getStats() });
  const rows = [row];
  const store = useEntityCardStore(createPinia());
  const manager = {
    layers: new Map(rows.map((r) => [r.id, r])),
    isEnabled: (id) => id === row.id,
    getAll: () => rows,
    subscribe() {},
  };
  store.connect({ dataManager: () => manager });
  const titles = () =>
    store
      .nearbyLayers(0, 0, { radiusKm: 25 })
      .flatMap((g) => g.items.map((i) => i.title));
  assert.deepEqual(titles(), ['ABC123']);
  layerState.subject = { ...layerState.subject, label: 'N123AB' };
  layerState.results.subject = layerState.subject;
  t.mock.timers.tick(10_000);
  assert.deepEqual(titles(), ['N123AB']);
});
