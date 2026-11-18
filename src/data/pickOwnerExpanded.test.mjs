/**
 * Which pick owners select nearby contacts. A coarse tap's shared contact
 * hit (`pickContact`) can land on a contact near an exact miss; only owners
 * whose click handlers act on such a hit, or on their own pick window,
 * register `expanded`, so a quake card or label yields to them and not to
 * exact-only owners (FIRMS, CCTV). Each case runs the layer's own
 * registration code (its enable or install step) with stand-in services.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle as createFlightLifecycle } from '../layers/flights/lifecycle.js';
import { createLifecycle as createMilitaryLifecycle } from '../layers/military/lifecycle.js';
import { createLifecycle as createVesselLifecycle } from '../layers/vessels/lifecycle.js';
import { createInteraction as createRadioInteraction } from '../layers/radio/interaction.js';
import { createSelection as createStreetSelection } from '../layers/streetLevel/selection.js';
import { fakeInput } from '../input/testDoubles.mjs';
import { STREET_LEVEL_LAYER_ID } from '../layers/streetLevel/policy.js';
import * as picking from './pickRegistry.js';

/**
 * A stand-in for any collaborator: every property is another stand-in and
 * every call returns one, except the keys `given` names. Not a thenable.
 */
function stub(given = {}) {
  return new Proxy(function stand() {}, {
    get(target, key) {
      if (key in given) return given[key];
      if (key === 'then' || typeof key === 'symbol') return undefined;
      return stub();
    },
    set(target, key, value) {
      given[key] = value;
      return true;
    },
    apply: () => stub(),
  });
}

/** Picking services that record each registration's options. */
function recordingPicking() {
  const registered = new Map();
  return {
    registered,
    services: {
      ...picking,
      registerPickOwner(layerId, predicate, options) {
        registered.set(layerId, options ?? {});
        picking.registerPickOwner(layerId, predicate, options);
      },
    },
  };
}

function withDocument(t, { cockpit = () => false } = {}) {
  const previous = globalThis.document;
  globalThis.document = {
    body: {
      classList: { contains: (name) => name === 'cockpit-mode' && cockpit() },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
}

/** A quake card over `pickedId` reached as a nearby touch contact. */
const actsOnNearbyHit = (pickedId) =>
  picking.isActedOnByOtherLayer('earthquakes', pickedId, { expanded: true });

for (const [name, layerId, create] of [
  ['flights', 'flights', createFlightLifecycle],
  ['military', 'military', createMilitaryLifecycle],
]) {
  test(`${name} registers its aircraft as acting on nearby touch hits`, (t) => {
    let cockpit = false;
    withDocument(t, { cockpit: () => cockpit });
    const { registered, services } = recordingPicking();
    const flightState = stub({
      _icons: { show: false, has: (id) => id === `${name}-1` },
      records: { geoidReady: true },
      timeline: null,
      _trackedIcao: null,
    });
    const { methods: lifecycle } = create({
      flightState,
      services: stub({ picking: services }),
      parts: stub(),
      layer: stub(),
      resolveAsset: () => '',
    });
    t.after(() => picking.unregisterPickOwner(layerId));
    lifecycle.enable({});
    assert.equal(registered.get(layerId)?.expanded, true);
    assert.equal(actsOnNearbyHit(`${name}-1`), true);
    // The handler ignores a dragged tap and any tap in cockpit mode, so the
    // aircraft acts on neither click.
    const nearby = (gesture) =>
      picking.isActedOnByOtherLayer('earthquakes', `${name}-1`, {
        expanded: true,
        click: { gesture },
      });
    assert.equal(nearby({ travelPx: 0, durationMs: 80 }), true, 'a tap');
    assert.equal(nearby({ travelPx: 12, durationMs: 80 }), false, 'a drag');
    cockpit = true;
    assert.equal(nearby({ travelPx: 0, durationMs: 80 }), false, 'cockpit');
    cockpit = false;
    // A click on the aircraft already tracked is ignored, so it is passive.
    flightState._trackedIcao = `${name}-1`;
    assert.equal(actsOnNearbyHit(`${name}-1`), false);
  });
}

test('vessels register their icons as acting on nearby touch hits', (t) => {
  withDocument(t);
  const { registered, services } = recordingPicking();
  const state = {
    feed: { enabled: true, sessionId: 1 },
    records: { byId: new Map([['vessel-1', {}]]) },
    viewer: {},
  };
  const created = createVesselLifecycle({
    vesselState: stub({ state, _geoidReady: true }),
    services: stub({ picking: services }),
    parts: stub(),
  });
  const lifecycle = created.methods ?? created;
  t.after(() => picking.unregisterPickOwner('ais-live-vessels'));
  lifecycle.enable({});
  assert.equal(registered.get('ais-live-vessels')?.expanded, true);
  assert.equal(actsOnNearbyHit('vessel-1'), true);
});

test('radio registers its stations as acting on nearby touch hits', (t) => {
  const { registered, services } = recordingPicking();
  const viewer = { scene: { canvas: new EventTarget(), pick: () => null } };
  const input = fakeInput(viewer);
  const state = { _viewer: viewer, _clickSubscription: null };
  const interaction = createRadioInteraction({
    state,
    services: { picking: services, overlays: stub() },
    parts: stub(),
  });
  t.after(() => {
    interaction.removeInteraction();
    input.destroy();
  });
  interaction.installInteraction();
  assert.equal(registered.get('radio')?.expanded, true);
  assert.equal(actsOnNearbyHit('radio:kexp'), true);
  interaction.removeInteraction();
  assert.equal(actsOnNearbyHit('radio:kexp'), false);
});

test('Street Level registers its picks as acting on nearby touch hits', (t) => {
  withDocument(t);
  const { registered, services } = recordingPicking();
  const viewer = { scene: { canvas: new EventTarget(), pick: () => null } };
  const input = fakeInput(viewer);
  const state = { services: { picking: services }, clickSubscription: null };
  const selection = createStreetSelection({
    state,
    parts: stub({
      router: {
        ownsPick: (id) => id === 'mly:seq-1',
        resolve: (id) => (id === 'mly:seq-1' ? { id, instance: {} } : null),
      },
    }),
  });
  t.after(() => {
    state.clickSubscription?.();
    picking.unregisterPickOwner(STREET_LEVEL_LAYER_ID);
    input.destroy();
  });
  selection.install(viewer);
  assert.equal(registered.get(STREET_LEVEL_LAYER_ID)?.expanded, true);
  assert.equal(actsOnNearbyHit('mly:seq-1'), true);
});
