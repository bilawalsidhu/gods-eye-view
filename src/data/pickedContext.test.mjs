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
  const picked = { set: 'flights:1', id: 'a1b2c3', surface: false };
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

test('a draw-set item resolves through the context record its meta carries', () => {
  const carrier = { show: true };
  registerEntityContext(carrier, {
    id: 'local-datacenters:8',
    layerId: 'local-datacenters',
    label: 'Data Center 8',
    latitude: 30.3,
    longitude: -97.5,
  });
  // A draw-set item's hit carries the item's meta as it was given.
  const picked = { set: 'local-datacenters#1:fills', id: '8', meta: carrier, surface: false };
  assert.deepEqual(resolvePickedContext(picked, { dataManager: manager() }), {
    layerId: 'local-datacenters',
    id: 'local-datacenters:8',
    label: 'Data Center 8',
    kind: 'feature',
    lat: 30.3,
    lon: -97.5,
  });
  // Hidden, it is not what the user points at.
  carrier.show = false;
  assert.equal(resolvePickedContext(picked, { dataManager: manager() }), null);
});

test('something drawn outside the draw port resolves through its pick owner', () => {
  registerPickOwner('flights', (id) => id === 'z9');
  const out = resolvePickedContext({ set: '', id: 'z9', surface: false }, { dataManager: manager() });
  assert.equal(out?.layerId, 'flights');
  assert.equal(out?.id, 'z9');
  unregisterPickOwner('flights');
});

test("a camera's projected image and view rays resolve to the camera", async (t) => {
  const { createControls } = await import('../layers/cctv/controls.js');
  const { ownsCctvPick } = await import('../layers/cctv/pickIds.js');
  const { GIZMO_ID_PREFIX } = await import('./cctvGizmo.js');
  const camera = { id: 'drivebc-17', name: 'Hwy 1 at Main', lat: 49.2, lon: -123.1 };
  const state = { _recordById: new Map([[camera.id, { camera }]]) };
  const cctv = createControls({ state, services: { render: {}, activation: {} }, parts: {}, source: {} }).methods;
  registerPickOwner('cctv', (id) => ownsCctvPick(id, state._recordById, GIZMO_ID_PREFIX));
  t.after(() => unregisterPickOwner('cctv'));
  assert.equal(findPickOwner(`${GIZMO_ID_PREFIX}ring-heading`), 'cctv');
  assert.equal(findPickOwner('cctv-unknown-plane'), null);
  const dataManager = manager({ enabled: new Set(['cctv']), modules: { cctv } });
  for (const pickId of ['drivebc-17', 'cctv-drivebc-17-plane', 'cctv-drivebc-17-ray-tl', 'cctv-drivebc-17-plane-label']) {
    const out = resolvePickedContext({ set: '', id: pickId, surface: false }, { dataManager });
    assert.equal(out?.id, 'drivebc-17', pickId);
    assert.equal(out?.label, 'Hwy 1 at Main', pickId);
    assert.equal(out?.lat, 49.2, pickId);
  }
});

test('a plane and a camera icon sharing an id open their own camera cards', async (t) => {
  const { createControls } = await import('../layers/cctv/controls.js');
  const { createRendering } = await import('../layers/cctv/rendering.js');
  const { ownsCctvPick } = await import('../layers/cctv/pickIds.js');
  const { GIZMO_ID_PREFIX } = await import('./cctvGizmo.js');
  const a = { id: 'cam-a', name: 'Camera A' };
  const b = { id: 'cctv-cam-a-plane', name: 'Camera B' };
  const state = {
    _recordById: new Map([[a.id, { camera: a, projection: { plane: { id: b.id } } }], [b.id, { camera: b }]]),
    _icons: { setId: 'icons', has: (id) => id === a.id || id === b.id },
  };
  const parts = { drawSets: { roleOfSet: (set) => set === 'planes' ? 'plane' : null } };
  const services = { render: {}, activation: {}, focus: {} };
  parts.rendering = createRendering({ state, services, parts });
  const cctv = createControls({ state, services, parts }).methods;
  registerPickOwner('cctv', (id) => ownsCctvPick(id, state._recordById, GIZMO_ID_PREFIX));
  t.after(() => unregisterPickOwner('cctv'));
  const dataManager = manager({ enabled: new Set(['cctv']), modules: { cctv } });
  const pick = (set) => resolvePickedContext({ set, id: b.id, meta: { cameraId: a.id } }, { dataManager });
  assert.equal(pick('planes')?.label, a.name);
  assert.equal(pick('icons')?.label, b.name);
  assert.equal(pick('another-layer'), null);
});

test('a failing layer pick mapper falls back to the original pick', (t) => {
  const pickId = 'cctv-sample-plane';
  registerPickOwner('cctv', (id) => id === pickId);
  t.after(() => unregisterPickOwner('cctv'));
  const dataManager = manager({
    enabled: new Set(['cctv']),
    modules: {
      cctv: {
        recordIdForPick() {
          throw new Error('camera mapping unavailable');
        },
        findByQuery(id) {
          assert.equal(id, pickId);
          return { name: 'Camera A', latitude: 49.2, longitude: -123.1 };
        },
      },
    },
  });
  assert.deepEqual(
    resolvePickedContext({ set: '', id: pickId, surface: false }, { dataManager }),
    {
      layerId: 'cctv',
      id: pickId,
      label: 'Camera A',
      kind: 'feature',
      lat: 49.2,
      lon: -123.1,
      altitudeM: null,
    },
  );
});

test('a part of an item drawn in parts resolves as the id its parts pick as', () => {
  registerPickOwner('flights', (id) => String(id).startsWith('seq:'));
  const out = resolvePickedContext(
    { set: 'lines:1', id: 'seq:42#2', meta: { pick: 'seq:42' }, surface: false },
    { dataManager: manager() },
  );
  assert.equal(out?.id, 'seq:42', 'never the part’s own #n id');
  unregisterPickOwner('flights');
});

test('disabled layers, trails and empty picks never resolve', () => {
  registerPickOwner('military', (id) => id === 'm1');
  const hit = (id) => ({ set: 'x:1', id, surface: false });
  assert.equal(resolvePickedContext(hit('m1'), { dataManager: manager() }), null, 'military is disabled');
  unregisterPickOwner('military');
  assert.equal(resolvePickedContext(hit('gev-trail:1'), { dataManager: manager() }), null);
  assert.equal(resolvePickedContext(null), null);
  assert.equal(resolvePickedContext({ set: '', id: '', surface: true }), null);
  assert.equal(resolvePickedContext(hit('unknown'), { dataManager: manager() }), null);
  assert.equal(pickedKindForLayer('ais-live-vessels'), 'vessel');
});
