// In-view entity context includes infrastructure drawn on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { registerEntityContext } from '../../../data/contextStore.js';
import { createGevActionRunner } from '../../../voice/gevActions.js';
import { createInfrastructureDisplay } from './display.js';

globalThis.window ||= { setTimeout, clearTimeout, requestIdleCallback: null };
globalThis.window.addEventListener ||= () => {};
globalThis.window.removeEventListener ||= () => {};
globalThis.window.dispatchEvent ||= () => true;

const DAMS = {
  id: 'local-dams',
  name: 'Dams',
  color: '#0088ff',
  source: 'USACE',
  osmDerived: true,
  labels: false,
};

test('in_view lists an on-screen dam', async (t) => {
  const engine = createFakeEngine({
    longitude: geo.math.toRadians(-97.7),
    latitude: geo.math.toRadians(30.2),
    altitude: 20_000,
    width: 800,
    height: 600,
  });
  const display = createInfrastructureDisplay(engine, {
    config: DAMS,
    services: {
      registerEntityContext,
      overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    },
  });
  t.after(() => {
    display.destroy();
    engine.destroy();
  });
  display.show({
    features: [
      {
        type: 'Feature',
        id: 'dam-1',
        properties: { name: 'Runtime Dam' },
        geometry: { type: 'Point', coordinates: [-97.7, 30.2] },
      },
    ],
    records: [
      {
        id: 'dam-1',
        lon: -97.7,
        lat: 30.2,
        properties: { name: 'Runtime Dam' },
        geometry: { type: 'Point', coordinates: [-97.7, 30.2] },
      },
    ],
  });
  const dataManager = {
    layers: new Map(),
    isEnabled: (id) => id === 'local-dams',
    getAll: () => [
      { id: 'local-dams', name: 'Dams', enabled: true, stats: {} },
    ],
  };
  const runner = createGevActionRunner({
    viewer: null,
    engine,
    styleManager: { runImmediateNavigation: (n, go) => go() },
    dataManager,
  });
  const result = await runner('get_entity_context', { scope: 'in_view' });
  assert.equal(result.ok, true);
  assert.ok(
    result.visible.some((entry) => String(entry.id).includes('dam-1')),
    `visible: ${JSON.stringify(result.visible)}`,
  );
});
