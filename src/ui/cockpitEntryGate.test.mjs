// src/ui/cockpitEntryGate.test.mjs — first person needs only the layer of
// the vehicle it rides: Contacts and the other feeds may be off before or
// during a session, turning the ridden layer off ends it, Contacts ending
// keeps the ridden layer it had turned on, and the voice gate and state say
// so without claiming Contacts is required. Over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { DataLayerManager } from '../data/manager.js';
import { createDependencies } from '../layers/awareness/dependencies.js';
import { CockpitCoordinator } from './cockpitCoordinator.js';
import { ContextControls } from './contextControls.js';
import { _handleContextLayerChange } from './contextLayerChanges.js';
import { useCockpitStore } from './stores/cockpit.js';
import { useHudStore } from './stores/hud.js';
import ContextView from './views/ContextView.vue';
import IntelHudView from './views/IntelHudView.vue';

const CIVIL = Object.freeze({
  icao24: 'abc123',
  callsign: 'UAL123',
  track: 92,
  latitude: 30,
  longitude: -97,
});
const MILITARY = Object.freeze({
  ...CIVIL,
  icao24: 'ae0001',
  callsign: 'RCH1',
});

function fixture(
  t,
  {
    enabled = [],
    tracked = null,
    contextMode = null,
    changing = false,
    dataManager: suppliedManager = null,
    readContext = null,
  } = {},
) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(
    defineComponent(() => () => [h(ContextView), h(IntelHudView)]),
  ).use(pinia);
  app.mount(host);
  const store = useCockpitStore(pinia);
  const layers = new Set(enabled);
  const dataManager = suppliedManager || {
    isEnabled: (layerId) => layers.has(layerId),
  };
  // A layer that is off has no tracked aircraft, as the flight layers clear
  // tracking on disable.
  const trackedFrom = (layerId) => () =>
    tracked?.layerId === layerId && dataManager.isEnabled(layerId)
      ? tracked.info
      : null;
  const entityFor = (subject) => ({
    position: { getValue: () => null },
    show: true,
    gevTrackedId: subject ? `${subject.layerId}:${subject.info.icao24}` : '',
  });
  const entities = new Set();
  const entity = entityFor(tracked);
  entities.add(entity);
  const listeners = () => ({ addEventListener: () => () => {} });
  const viewer = {
    trackedEntity: tracked ? entity : undefined,
    clock: { currentTime: null },
    camera: { cancelFlight() {}, frustum: { fov: 1, aspectRatio: 1 } },
    entities: { contains: (candidate) => entities.has(candidate) },
    scene: {
      preUpdate: listeners(),
      screenSpaceCameraController: { enableInputs: true },
    },
    trackedEntityChanged: listeners(),
  };
  const context = { mode: contextMode, changing };
  const coordinator = new CockpitCoordinator({
    viewer,
    services: {
      flightsLayer: { getTrackedInfo: trackedFrom('flights') },
      militaryFlightsLayer: { getTrackedInfo: trackedFrom('military') },
      militaryAwarenessLayer: { getContextSnapshot: () => null },
      isTr3b: () => false,
      holdContinuousRender() {},
      releaseContinuousRender() {},
    },
    elements: {},
    operations: {
      publishCockpit: { presence: (view) => store.publishPresence(view) },
      _stampNavigation() {},
      getAircraftTrackingTarget: () =>
        tracked ? { layerId: tracked.layerId, id: tracked.info.icao24 } : null,
    },
    readDataManager: () => dataManager,
    readContext: readContext || (() => context),
    readActiveStyle: () => 'normal',
    readUtilityDisclosureOpen: () => false,
    enterPanels() {},
    exitPanels() {},
  });
  const cockpit = coordinator.cockpitView;
  // The HUD, briefing and signals have their own tests.
  Object.assign(cockpit, {
    updateHud() {},
    setVisionMode() {},
    showBriefPage() {},
    startBriefRotation() {},
    stopBriefRotation() {},
    pushCockpitSignal() {},
    scheduleContextLayout() {},
    clearPredictiveRoute() {},
  });
  t.after(() => {
    coordinator.stop();
    app.unmount();
    document.body.classList.remove('cockpit-mode');
  });
  /** Turn a layer off and tell the Context owner, as the data manager does. */
  const disable = (layerId) => {
    layers.delete(layerId);
    _handleContextLayerChange.call(
      {
        cockpitView: cockpit,
        _dataManager: dataManager,
        _contextMode: null,
        _contextModeChanging: false,
        _contextSessionSnapshot: null,
        _contextRestoreState: null,
        _syncContextModeButtons() {},
      },
      { type: 'visibility', layerId, enabled: false, origin: 'user' },
    );
  };
  /** Track another aircraft, as Contacts navigation does mid-session. */
  const retrack = (subject) => {
    tracked = subject;
    viewer.trackedEntity = entityFor(subject);
    entities.add(viewer.trackedEntity);
  };
  const $ = (selector) => document.querySelector(selector);
  return { $, coordinator, cockpit, store, layers, disable, retrack, pinia };
}

test('a civilian aircraft enters with Live Flights alone: no Contacts, no Military', (t) => {
  const { coordinator, cockpit } = fixture(t, {
    enabled: ['flights'],
    tracked: { layerId: 'flights', info: CIVIL },
  });
  const state = coordinator.getCockpitState();
  assert.equal(state.entryAllowed, true);
  assert.equal(state.entryBlockedReason, null);
  assert.equal(cockpit.enter(), true);
});

test('a military aircraft enters with Military Flights alone', (t) => {
  const { coordinator, cockpit } = fixture(t, {
    enabled: ['military'],
    tracked: { layerId: 'military', info: MILITARY },
  });
  assert.equal(coordinator.getCockpitState().entryAllowed, true);
  assert.equal(cockpit.enter(), true);
});

test('a Context change in flight still blocks entry, and says so', (t) => {
  const { coordinator, cockpit } = fixture(t, {
    enabled: ['flights', 'military'],
    tracked: { layerId: 'flights', info: CIVIL },
    contextMode: 'flights',
    changing: true,
  });
  const state = coordinator.getCockpitState();
  assert.equal(state.entryAllowed, false);
  assert.equal(state.entryBlockedReason, 'contacts-starting');
  assert.equal(cockpit.enter(), false);
  const voice = coordinator.controlCockpit('enter');
  assert.equal(voice.ok, false);
  assert.match(voice.error, /Context is still changing/);
  assert.equal(cockpit.active, false);
});

test('with no aircraft layer on, entry is refused for that reason, never for Contacts', (t) => {
  const { coordinator, cockpit } = fixture(t);
  const state = coordinator.getCockpitState();
  assert.equal(state.entryBlockedReason, 'subject-layer-off');
  const voice = coordinator.controlCockpit('enter');
  assert.equal(voice.ok, false);
  assert.match(voice.error, /No aircraft layer is on/);
  assert.doesNotMatch(voice.error, /contacts/i);
  assert.equal(voice.state.entryBlockedReason, 'subject-layer-off');
  assert.equal(cockpit.active, false);
});

test('with an aircraft layer on but nothing tracked, the reason is the missing aircraft', (t) => {
  const { coordinator } = fixture(t, { enabled: ['military'] });
  assert.equal(
    coordinator.getCockpitState().entryBlockedReason,
    'no-tracked-aircraft',
  );
});

test('voice enters without Contacts when the ridden layer is on', (t) => {
  const { coordinator, cockpit } = fixture(t, {
    enabled: ['flights'],
    tracked: { layerId: 'flights', info: CIVIL },
  });
  const result = coordinator.controlCockpit('enter');
  assert.equal(result.ok, true, result.error);
  assert.equal(cockpit.active, true);
});

test('other layers may be turned off during a session; the ridden layer ends it', (t) => {
  const { cockpit, disable } = fixture(t, {
    enabled: ['flights', 'military', 'ais-live-vessels'],
    tracked: { layerId: 'flights', info: CIVIL },
  });
  assert.equal(cockpit.enter(), true);
  disable('military');
  disable('ais-live-vessels');
  assert.equal(cockpit.active, true, 'other feeds are free to go off');
  disable('flights');
  assert.equal(cockpit.active, false, 'the ridden layer going off ends it');
});

test('the readout offers the same entry, labelled by kind, and enters on click', async (t) => {
  const { $, cockpit, pinia } = fixture(t, {
    enabled: ['flights'],
    tracked: { layerId: 'flights', info: CIVIL },
  });
  useHudStore(pinia);
  const readoutEntry = $('#cockpit-entry-readout');
  assert.equal(readoutEntry.hidden, true, 'hidden until entry is available');
  cockpit.syncEntry();
  await nextTick();
  assert.equal(readoutEntry.hidden, false);
  assert.match(readoutEntry.textContent, /flight/);
  assert.match(readoutEntry.textContent, /COCKPIT/);
  assert.equal(
    $('#cockpit-entry').hidden,
    false,
    'the Contacts entry follows the same presence',
  );
  readoutEntry.click();
  await nextTick();
  assert.equal(cockpit.active, true);
  assert.equal(readoutEntry.hidden, true, 'inside, there is nothing to enter');
});

const AIR_AND_SEA = [
  'flights',
  'military',
  'ais-live-vessels',
  'military-installations',
];

/** A source layer that settles at once, as the data manager drives it. */
function sourceLayer(id) {
  return {
    id,
    name: id,
    icon: '',
    source: 'test',
    updateInterval: -1,
    init() {},
    enable() {},
    disable() {},
    update() {},
    getStats: () => ({ count: 0, lastUpdate: null }),
  };
}

/**
 * Contacts as the manager sees it: a coordinator whose real dependency
 * ownership (src/layers/awareness/dependencies.js) turns on the air and sea
 * layers it finds off and releases them when it goes off.
 */
function contactsCoordinator() {
  const state = {
    dataManager: null,
    enabled: false,
    passive: true,
    activationId: 0,
    ownedDependencies: new Set(),
    subject: null,
    autoFocusRetryPending: false,
  };
  const dependencies = createDependencies({
    state,
    services: {},
    parts: { subject: {}, focus: {} },
    source: null,
  });
  return {
    id: 'military-awareness',
    name: 'Contacts',
    icon: '',
    source: 'test',
    showInTogglePanel: false,
    updateInterval: -1,
    attachDataManager(dataManager) {
      state.dataManager = dataManager;
      dependencies.watchAdoptions(dataManager);
    },
    setParams(params = {}) {
      if (typeof params.passive === 'boolean') state.passive = params.passive;
    },
    getParams: () => ({ passive: state.passive }),
    init() {},
    enable() {
      state.enabled = true;
      if (!state.passive) return dependencies.enableDependencies();
      return true;
    },
    disable() {
      state.enabled = false;
      state.passive = true;
      return dependencies.releaseOwnedDependencies(++state.activationId);
    },
    update() {},
    getStats: () => ({ count: 0, lastUpdate: null }),
  };
}

/**
 * The Cockpit beside the real Context owner and data manager, so a Contacts
 * exit runs its whole restore: the coordinator's releases, then the snapshot.
 */
async function liveFixture(t, { enabled = [], tracked = null } = {}) {
  const manager = new DataLayerManager({});
  for (const layerId of AIR_AND_SEA) manager.register(sourceLayer(layerId));
  const coordinatorModule = contactsCoordinator();
  manager.register(coordinatorModule);
  coordinatorModule.attachDataManager(manager);
  for (const layerId of enabled) await manager.setEnabled(layerId, true);
  let cockpit = null;
  const controls = new ContextControls({
    elements: {},
    installations: {},
    actions: {
      getCockpit: () => cockpit,
      claimVisualAuthority() {},
      showToast() {},
      setClearBusy() {},
      syncDetection() {},
      scheduleLayout() {},
      refreshRadio() {},
      setPanelCollapsed() {},
    },
  });
  controls.connect(manager);
  t.after(() => {
    controls.stop();
    controls.disconnect();
  });
  const base = fixture(t, {
    tracked,
    dataManager: manager,
    readContext: () => controls.getContextModeState(),
  });
  cockpit = base.cockpit;
  /** Let every Context reaction the last change started settle. */
  const settle = async () => {
    for (let turn = 0; turn < 5; turn += 1) {
      await controls._waitForContextLayerSettlement();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { ...base, manager, controls, settle };
}

const on = (manager) =>
  [...AIR_AND_SEA, 'military-awareness'].filter((layerId) =>
    manager.isEnabled(layerId),
  );

test('Contacts ending in a Cockpit session keeps the ridden layer it had turned on', async (t) => {
  for (const [label, endContacts] of [
    [
      'Military Flights off',
      ({ manager }) =>
        manager.setEnabled('military', false, { origin: 'user' }),
    ],
    [
      'Contacts off by its own layer',
      ({ manager }) =>
        manager.setEnabled('military-awareness', false, { origin: 'user' }),
    ],
    [
      'Contacts off from its chooser',
      ({ controls }) => controls._selectContextMode(null),
    ],
  ]) {
    await t.test(label, async (t) => {
      // Live Flights is off on the map; Contacts turns it on as its own.
      const live = await liveFixture(t, {
        tracked: { layerId: 'flights', info: CIVIL },
      });
      const { manager, controls, cockpit, settle } = live;
      assert.equal(await controls._selectContextMode('flights'), true);
      await settle();
      assert.deepEqual(on(manager), [...AIR_AND_SEA, 'military-awareness']);
      assert.equal(cockpit.enter(), true);
      await endContacts(live);
      await settle();
      assert.equal(controls.getContextModeState().mode, null, 'Contacts ended');
      assert.equal(cockpit.active, true, 'the Cockpit rides on');
      assert.deepEqual(
        on(manager),
        ['flights'],
        'only the ridden layer outlives the pre-Contacts restore',
      );
    });
  }
});

test('a ride handed to an aircraft on a layer Contacts turned on keeps that layer', async (t) => {
  const live = await liveFixture(t, {
    enabled: ['flights'],
    tracked: { layerId: 'flights', info: CIVIL },
  });
  const { manager, controls, cockpit, retrack, settle } = live;
  assert.equal(await controls._selectContextMode('flights'), true);
  await settle();
  assert.equal(cockpit.enter(), true);
  // NEXT hands the view to a military aircraft; Contacts turned its layer on.
  retrack({ layerId: 'military', info: MILITARY });
  assert.equal(cockpit._adoptTrackedEntity(performance.now()), true);
  assert.equal(cockpit.readSubjectLayerId(), 'military');
  await manager.setEnabled('ais-live-vessels', false, { origin: 'user' });
  await settle();
  assert.equal(controls.getContextModeState().mode, null);
  assert.equal(cockpit.active, true);
  assert.deepEqual(on(manager), ['flights', 'military']);
});

test('the ridden layer still ends the Cockpit while Contacts is on', async (t) => {
  const live = await liveFixture(t, {
    tracked: { layerId: 'flights', info: CIVIL },
  });
  const { manager, controls, cockpit, settle } = live;
  assert.equal(await controls._selectContextMode('flights'), true);
  await settle();
  assert.equal(cockpit.enter(), true);
  await manager.setEnabled('flights', false, { origin: 'user' });
  await settle();
  assert.equal(cockpit.active, false);
  assert.equal(manager.isEnabled('flights'), false);
});

test('without a Cockpit, ending Contacts restores the layers it found', async (t) => {
  const live = await liveFixture(t, {
    tracked: { layerId: 'flights', info: CIVIL },
  });
  const { manager, controls, settle } = live;
  assert.equal(await controls._selectContextMode('flights'), true);
  await settle();
  await manager.setEnabled('military', false, { origin: 'user' });
  await settle();
  assert.equal(controls.getContextModeState().mode, null);
  assert.deepEqual(on(manager), [], 'Live Flights goes back off');
});
