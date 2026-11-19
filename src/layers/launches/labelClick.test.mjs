// Clicks on painted mission labels, routed through the real input dispatcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Event } from 'cesium';
import { createLifecycle } from './lifecycle.js';
import { createState } from './state.js';
import {
  ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
  ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
} from './policy.js';
import {
  FAKE_EVENT_TYPES,
  FakeScreenSpaceEventHandler,
  fakeInput,
} from '../../input/testDoubles.mjs';
import { bindFakeCesiumCamera } from '../../testSupport/fakeCameraPort.mjs';

const noop = () => {};

/** Parts whose every method is a no-op unless given. */
function stub(methods = {}) {
  return new Proxy(methods, {
    get: (target, key) => (key in target ? target[key] : noop),
  });
}

function rig(t, { overlayHit = null, geometryLaunchId = null } = {}) {
  const stock = new FakeScreenSpaceEventHandler();
  stock.setInputAction(noop, FAKE_EVENT_TYPES.LEFT_CLICK);
  const viewer = bindFakeCesiumCamera({
    isDestroyed: () => false,
    screenSpaceEventHandler: stock,
    camera: {
      moveStart: new Event(),
      moveEnd: new Event(),
      pickEllipsoid: () => null,
    },
    scene: {
      canvas: { style: { cursor: '' } },
      screenSpaceCameraController: { enableInputs: true },
      pick: () => undefined,
      drillPick: () => [],
    },
  });
  const pointer = fakeInput(viewer);
  const services = {
    overlays: {
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
      clearOverlaySource: noop,
      hitTestWorldOverlay: () => overlayHit,
    },
    render: { holdContinuousRender: noop, releaseContinuousRender: noop },
  };
  const state = createState({ services });
  const focused = [];
  const restoreFailure = { error: null };
  const parts = {
    panel: stub(),
    overlays: stub(),
    replay: stub(),
    launchPad: stub(),
    orbitRendering: stub(),
    selection: stub({
      setSelectedMission: (id) => focused.push(id),
    }),
    satelliteIntents: stub(),
    ingestion: stub({
      async restoreSatelliteDependency() {
        if (restoreFailure.error) throw restoreFailure.error;
      },
    }),
    rendering: stub({
      missionsShown: () => true,
      missionHitsAt: () => [],
      launchIdFromPicks: () => geometryLaunchId,
      launchMarkerAt: () => null,
    }),
  };
  const lifecycle = createLifecycle({
    state,
    services,
    parts,
    source: {},
  }).methods;
  lifecycle.init(viewer);
  state._enabled = true;
  state._launches = [{ id: 'L1' }, { id: 'L2' }];
  // Another layer's ambient click handler, as aircraft or the cockpit has.
  const ambient = [];
  const offAmbient = pointer.input.onClick((event) => ambient.push(event));
  t.after(async () => {
    restoreFailure.error = null;
    offAmbient();
    await lifecycle.destroy(viewer);
    pointer.input.destroy();
  });
  return {
    focused,
    ambient,
    state,
    lifecycle,
    viewer,
    input: pointer.input,
    restoreFailure,
    setHit(hit) {
      overlayHit = hit;
    },
    click: () => pointer.tap({ x: 40, y: 30 }),
  };
}

const label = (
  entryId,
  sourceId = ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
) => ({
  sourceId,
  entryId,
});

test('a mission label click focuses its launch and stops the click there', (t) => {
  const r = rig(t, { overlayHit: label('launch:L2') });
  r.click();
  assert.deepEqual(r.focused, ['L2']);
  assert.equal(r.ambient.length, 0, 'the layers beneath do not see it');

  r.setHit(label('launch:L1', ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID));
  r.click();
  assert.deepEqual(r.focused, ['L2', 'L1'], 'the selected label routes too');
});

test('a mission picked on the globe is announced, after it is selected', (t) => {
  const r = rig(t, { overlayHit: label('launch:L2') });
  const picks = [];
  r.state._globePickListeners.add((id) => picks.push([id, [...r.focused]]));
  r.click();
  assert.deepEqual(picks, [['L2', ['L2']]], 'the label pick is announced');

  r.setHit(null);
  r.click();
  assert.equal(picks.length, 1, 'a click on nothing announces nothing');
});

test('a throwing globe-pick listener does not stop the pick', (t) => {
  const r = rig(t, { overlayHit: label('launch:L1') });
  const warn = console.warn;
  console.warn = noop;
  t.after(() => {
    console.warn = warn;
  });
  const heard = [];
  r.state._globePickListeners.add(() => {
    throw new Error('listener failure');
  });
  r.state._globePickListeners.add((id) => heard.push(id));
  r.click();
  assert.deepEqual(r.focused, ['L1']);
  assert.deepEqual(heard, ['L1']);
  assert.equal(r.ambient.length, 0);
});

test('a mission label for an unknown launch falls through to other layers', (t) => {
  const r = rig(t, {
    overlayHit: label('launch:gone'),
    geometryLaunchId: 'L1',
  });
  r.click();
  assert.deepEqual(r.focused, [], 'nothing is focused');
  assert.equal(r.ambient.length, 1, 'other layers still get the click');
});

test("another layer's label keeps the click above mission geometry", (t) => {
  // An aircraft label painted over a mission path.
  const r = rig(t, {
    overlayHit: { sourceId: 'aircraft-labels', entryId: 'launch:L1' },
    geometryLaunchId: 'L1',
  });
  r.click();
  assert.deepEqual(r.focused, [], 'the mission under the label is not picked');
  assert.equal(r.ambient.length, 1, "the label's owner gets the click");

  // With no label there, the same click picks the mission geometry.
  r.setHit(null);
  r.click();
  assert.deepEqual(r.focused, ['L1']);
});

test('a mission label leaves the click to the cockpit while it is on', (t) => {
  const r = rig(t, { overlayHit: label('launch:L2') });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      body: { classList: { contains: (name) => name === 'cockpit-mode' } },
    },
  });
  try {
    r.click();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  }
  assert.deepEqual(r.focused, []);
  assert.equal(r.ambient.length, 1, 'the cockpit click handler gets it');
});

test('destroy releases the click handlers when the Satellites restore fails', async (t) => {
  const r = rig(t, { overlayHit: label('launch:L2') });
  const before = r.input.subscriberCount();
  r.restoreFailure.error = new Error('injected Satellites restore failure');
  await assert.rejects(r.lifecycle.destroy(r.viewer), /injected/);
  assert.equal(r.state._inputSubscription, null);
  // The rest of teardown still ran before the failure was reported.
  assert.equal(r.state._viewer, null, 'the viewer is released');
  assert.deepEqual(r.state._launches, [], 'the records are dropped');
  assert.equal(r.state._dataManager, null, 'the manager is released');
  assert.ok(r.input.subscriberCount() < before, 'the handlers unsubscribed');
  r.click();
  assert.deepEqual(r.focused, [], 'a later label click reaches no mission');
  assert.equal(r.ambient.length, 1);
});
