import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window ||= globalThis;
globalThis.CustomEvent ||= class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};
globalThis.dispatchEvent ||= () => true;

const { registerEntityContext } = await import('./contextStore.js');
const { registerPickOwner, unregisterPickOwner, findPickOwner } = await import('./pickRegistry.js');
const { resolvePickedContext, pickedKindForLayer } = await import('./pickedContext.js');

function manager({ enabled = new Set(['flights', 'local-datacenters']), modules = {} } = {}) {
  return {
    isEnabled: (id) => enabled.has(id),
    layers: new Map(Object.entries(modules).map(([id, module]) => [id, { name: id, module }])),
  };
}

test('an aircraft billboard resolves through its pick owner to a live label', () => {
  registerPickOwner('flights', (id) => id === 'a1b2c3');
  const dataManager = manager({
    modules: {
      flights: {
        findByQuery: (q) => (q === 'a1b2c3' ? { icao24: 'a1b2c3', callsign: 'UPS793', latitude: 30.2, longitude: -97.7, altitudeM: 9000 } : null),
      },
    },
  });
  const picked = { id: 'a1b2c3', primitive: {} };
  assert.equal(findPickOwner('a1b2c3'), 'flights');
  assert.deepEqual(resolvePickedContext(picked, { dataManager }), {
    layerId: 'flights',
    id: 'a1b2c3',
    label: 'UPS793',
    kind: 'aircraft',
    lat: 30.2,
    lon: -97.7,
    altitudeM: 9000,
  });
  unregisterPickOwner('flights');
});

test('an entity-backed feature resolves through the context store', () => {
  const entity = { show: true };
  registerEntityContext(entity, {
    id: 'local-datacenters:7',
    layerId: 'local-datacenters',
    label: 'Data Center 7',
    latitude: 30.1,
    longitude: -97.6,
  });
  const out = resolvePickedContext({ id: entity }, { dataManager: manager() });
  assert.deepEqual(out, {
    layerId: 'local-datacenters',
    id: 'local-datacenters:7',
    label: 'Data Center 7',
    kind: 'feature',
    lat: 30.1,
    lon: -97.6,
  });
});

test('disabled layers, trails and empty picks never resolve', () => {
  registerPickOwner('military', (id) => id === 'm1');
  assert.equal(resolvePickedContext({ id: 'm1' }, { dataManager: manager() }), null, 'military is disabled');
  unregisterPickOwner('military');
  assert.equal(resolvePickedContext({ id: 'gev-trail:1' }, { dataManager: manager() }), null);
  assert.equal(resolvePickedContext(null), null);
  assert.equal(resolvePickedContext({ id: 'unknown' }, { dataManager: manager() }), null);
  assert.equal(pickedKindForLayer('ais-live-vessels'), 'vessel');
});
