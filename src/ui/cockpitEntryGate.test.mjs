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
/** A tracked satellite, as the Satellites layer reports it. */
const SATELLITE = Object.freeze({
  kind: 'satellite',
  layerId: 'satellites',
  id: '25544',
  noradId: 25544,
  name: 'ISS (ZARYA)',
  classLabel: 'STATION · ISS',
  latitude: 30,
  longitude: -97,
  altitudeM: 420_000,
  velocityMps: 7_660,
  stale: false,
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
    satellite = null,
    contextMode = null,
    changing = false,
    dataManager: suppliedManager = null,
    readContext = null,
    subjects = [],
    vessel = null,
  } = {},
) {
  let selectedVessel = vessel;
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
      // Like the layer, no subject while Live AIS Vessels is off.
      aisLiveVesselsLayer: {
        getCockpitSubject: () =>
          selectedVessel && layers.has('ais-live-vessels')
            ? { ...selectedVessel }
            : null,
      },
      // Like the layer, no subject while Satellites is off.
      satellitesLayer: {
        getCockpitSubject: () =>
          satellite && layers.has('satellites') ? { ...satellite } : null,
        getCockpitPosition: () => null,
        setCockpitSubject: () => true,
      },
      militaryAwarenessLayer: { getContextSnapshot: () => null },
      isTr3b: () => false,
      holdContinuousRender() {},
      releaseContinuousRender() {},
      cockpitSubjects: subjects,
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
    document.body.classList.remove(
      'cockpit-mode',
      'cockpit-bridge',
      'cockpit-orbit',
      'cockpit-subject',
    );
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
  /** Select a vessel on the map, or none. */
  const selectVessel = (info) => {
    selectedVessel = info;
  };
  const $ = (selector) => document.querySelector(selector);
  return {
    $,
    coordinator,
    cockpit,
    store,
    layers,
    disable,
    retrack,
    selectVessel,
    pinia,
  };
}

/** A selected vessel as the AIS layer gives it to the bridge view. */
const VESSEL = Object.freeze({
  id: '211000001',
  name: 'EXAMPLE',
  latitude: 54,
  longitude: 10,
  headingDeg: 90,
  courseDeg: 90,
  speedMps: 5,
});

test('a civilian aircraft enters with Live Flights alone: no Contacts, no Military', (t) => {
  const { coordinator, cockpit } = fixture(t, {
    enabled: ['flights'],
    tracked: { layerId: 'flights', info: CIVIL },
  });
  const state = coordinator.getCockpitState();
  assert.equal(state.entryAllowed, true);
  assert.equal(state.entryBlockedReason, null);
  assert.equal(cockpit.enter(), true);
  assert.equal(cockpit.subjectKind, 'aircraft');
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

test('voice entry on a vessel bridge refuses before it touches tracking', (t) => {
  const { coordinator, cockpit } = fixture(t, { enabled: ['flights'] });
  let navigated = false;
  coordinator.services.militaryAwarenessLayer.navigateNext = () => {
    navigated = true;
    return true;
  };
  // Stand in for a bridge ride: the refusal reads only these two.
  cockpit.active = true;
  cockpit.subjectKind = 'vessel';
  t.after(() => {
    cockpit.active = false;
    cockpit.subjectKind = null;
  });
  const voice = coordinator.controlCockpit('enter', { targetLayer: 'flights' });
  assert.equal(voice.ok, false);
  assert.match(voice.error, /vessel bridge/);
  assert.equal(navigated, false, 'no aircraft was tracked');
  assert.equal(cockpit.subjectKind, 'vessel');
});

test('voice entry in an orbital view refuses before it touches tracking', (t) => {
  const { coordinator, cockpit } = fixture(t, { enabled: ['flights'] });
  let navigated = false;
  coordinator.services.militaryAwarenessLayer.navigateNext = () => {
    navigated = true;
    return true;
  };
  cockpit.active = true;
  cockpit.subjectKind = 'satellite';
  t.after(() => {
    cockpit.active = false;
    cockpit.subjectKind = null;
  });
  const voice = coordinator.controlCockpit('enter', { targetLayer: 'flights' });
  assert.equal(voice.ok, false);
  assert.match(voice.error, /orbital view/);
  assert.equal(navigated, false, 'no aircraft was tracked');
  assert.equal(cockpit.subjectKind, 'satellite');
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

test('Live AIS Vessels, once adopted as the ridden layer, outlives Contacts', async (t) => {
  const live = await liveFixture(t, {
    tracked: { layerId: 'flights', info: CIVIL },
  });
  const { manager, controls, coordinator, settle } = live;
  assert.equal(await controls._selectContextMode('flights'), true);
  await settle();
  assert.equal(manager.isEnabled('ais-live-vessels'), true);
  // The bridge reports its layer on entry (cockpitBridge.test.mjs).
  coordinator._adoptRiddenLayer('ais-live-vessels');
  await controls._selectContextMode(null);
  await settle();
  assert.equal(controls.getContextModeState().mode, null);
  assert.deepEqual(on(manager), ['ais-live-vessels']);
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

test('the readout entry reads BRIDGE for a selected vessel', async (t) => {
  const { $, store } = fixture(t);
  store.publishPresence({
    active: false,
    entryAvailable: true,
    entryKind: 'vessel',
    subjectKind: null,
    tr3b: null,
  });
  await nextTick();
  const readoutEntry = $('#cockpit-entry-readout');
  assert.equal(readoutEntry.hidden, false);
  assert.match(readoutEntry.textContent, /directions_boat/);
  assert.match(readoutEntry.textContent, /BRIDGE/);
});

test('without providers the built-in order decides: a vessel selected after an aircraft still reads COCKPIT', async (t) => {
  const { $, cockpit, store, selectVessel } = fixture(t, {
    enabled: ['flights', 'ais-live-vessels'],
    tracked: { layerId: 'flights', info: CIVIL },
  });
  cockpit.syncEntry();
  assert.equal(store.presence.entryKind, 'aircraft');
  await new Promise((resolve) => setTimeout(resolve, 2));
  selectVessel(VESSEL);
  cockpit.syncEntry();
  await nextTick();
  assert.equal(store.presence.entryKind, 'aircraft');
  assert.match($('#cockpit-entry-readout').textContent, /COCKPIT/);
  // And the other way round: an aircraft tracked after the vessel.
  const later = fixture(t, {
    enabled: ['flights', 'ais-live-vessels'],
    vessel: VESSEL,
  });
  later.cockpit.syncEntry();
  assert.equal(later.store.presence.entryKind, 'vessel');
  await new Promise((resolve) => setTimeout(resolve, 2));
  later.retrack({ layerId: 'flights', info: CIVIL });
  later.cockpit.syncEntry();
  assert.equal(later.store.presence.entryKind, 'aircraft');
});

test('a tracked satellite needs Satellites on for the ORBIT entry', async (t) => {
  const { $, cockpit } = fixture(t, { satellite: SATELLITE });
  cockpit.syncEntry();
  await nextTick();
  assert.equal($('#cockpit-entry').hidden, true, 'Satellites off: no entry');
  assert.equal(cockpit.enter(), false);
});

test('with Satellites on, the tracked satellite offers ORBIT and reports itself', async (t) => {
  const { $, cockpit, coordinator, pinia } = fixture(t, {
    enabled: ['satellites'],
    satellite: SATELLITE,
  });
  useHudStore(pinia);
  cockpit.syncEntry();
  await nextTick();
  for (const selector of ['#cockpit-entry', '#cockpit-entry-readout']) {
    assert.equal($(selector).hidden, false, selector);
    assert.match($(selector).textContent, /satellite_alt/);
    assert.match($(selector).textContent, /ORBIT/);
  }
  // Voice stays aircraft-only: it neither offers nor takes the satellite.
  assert.equal(coordinator.getCockpitState().entryAllowed, false);
  assert.equal(coordinator.controlCockpit('enter').ok, false);
  assert.equal(cockpit.active, false);
  $('#cockpit-entry-readout').click();
  await nextTick();
  assert.equal(cockpit.active, true);
  assert.equal(cockpit.subjectKind, 'satellite');
  const state = coordinator.getCockpitState();
  assert.equal(state.active, true);
  assert.deepEqual(state.subject, {
    kind: 'satellite',
    id: '25544',
    layerId: 'satellites',
    callsign: null,
    name: 'ISS (ZARYA)',
  });
});

test('tracked debris offers no ORBIT entry and refuses to be entered', async (t) => {
  const { $, cockpit } = fixture(t, {
    enabled: ['satellites'],
    satellite: {
      ...SATELLITE,
      id: '27386',
      noradId: 27386,
      name: 'SL-16 R/B',
      satelliteClass: 'debris',
      enterable: false,
    },
  });
  cockpit.syncEntry();
  await nextTick();
  for (const selector of ['#cockpit-entry', '#cockpit-entry-readout'])
    assert.equal($(selector).hidden, true, selector);
  assert.equal(cockpit.enter(), false);
  assert.equal(cockpit.enter({ kind: 'satellite' }), false);
  assert.equal(cockpit.active, false);
});

test('a Context change in flight blocks the orbital view too', (t) => {
  const { cockpit } = fixture(t, {
    enabled: ['satellites'],
    satellite: SATELLITE,
    changing: true,
  });
  assert.equal(cockpit.enter(), false);
});

test('turning Satellites off ends the orbital view', (t) => {
  const { cockpit, disable } = fixture(t, {
    enabled: ['satellites', 'flights'],
    satellite: SATELLITE,
  });
  assert.equal(cockpit.enter(), true);
  disable('flights');
  assert.equal(cockpit.active, true, 'other feeds are free to go off');
  disable('satellites');
  assert.equal(cockpit.active, false);
});

/** An application provider whose subject sits on `example-layer`. */
function exampleSubject() {
  const released = [];
  return {
    released,
    provider: {
      kind: 'example-kind',
      layerId: 'example-layer',
      entryFace: { icon: 'commute', label: 'RIDE' },
      labels: { view: 'Example view', exit: 'Exit example', exitText: 'EXIT' },
      candidate: () => ({ id: 'a1', name: 'Example 12' }),
      hold: () => true,
      read: () => ({
        id: 'a1',
        name: 'Example 12',
        latitude: 30,
        longitude: -97,
        heightM: 200,
        headingDeg: 90,
        eye: { upM: 2 },
      }),
      hud: () => ({ title: 'Example 12' }),
      release: (id, { restore }) => released.push([id, restore]),
    },
  };
}

test("a provider's subject needs only its own layer, and never a Context change in flight", async (t) => {
  const { provider } = exampleSubject();
  let changing = false;
  const off = fixture(t, { subjects: [provider] });
  off.cockpit.syncEntry();
  await nextTick();
  assert.equal(off.$('#cockpit-entry').hidden, true, 'its layer is off');
  assert.equal(off.cockpit.enter(), false);
  const on = fixture(t, {
    enabled: ['example-layer'],
    subjects: [provider],
    readContext: () => ({ mode: null, changing }),
  });
  changing = true;
  on.cockpit.syncEntry();
  await nextTick();
  assert.equal(on.$('#cockpit-entry').hidden, true, 'Context is changing');
  changing = false;
  on.cockpit.syncEntry();
  await nextTick();
  assert.equal(on.$('#cockpit-entry').hidden, false);
  assert.match(on.$('#cockpit-entry').textContent, /RIDE/);
  assert.match(on.$('#cockpit-entry-readout').textContent, /commute/);
});

test("a provider's view reports its subject, refuses voice entry and ends with its layer", async (t) => {
  const { provider, released } = exampleSubject();
  const { cockpit, coordinator, disable } = fixture(t, {
    enabled: ['example-layer', 'flights'],
    subjects: [provider],
  });
  cockpit.syncEntry();
  assert.equal(cockpit.enter(), true);
  const state = coordinator.getCockpitState();
  assert.equal(state.active, true);
  assert.deepEqual(state.subject, {
    kind: 'example-kind',
    id: 'a1',
    layerId: 'example-layer',
    callsign: null,
    name: 'Example 12',
  });
  assert.equal(coordinator.controlCockpit('enter').ok, false);
  assert.match(coordinator._cockpitEntryRefusal(), /another first-person view/);
  disable('flights');
  assert.equal(cockpit.active, true, 'another layer is free to go off');
  disable('example-layer');
  assert.equal(cockpit.active, false, 'its own layer going off ends it');
  assert.deepEqual(released, [['a1', false]]);
});

test("a provider's guards: a throwing candidate, gate or release, and a gate that is not true", async (t) => {
  const warned = [];
  t.mock.method(console, 'warn', (message) => warned.push(String(message)));
  const entered = (provider) => {
    const { cockpit } = fixture(t, {
      enabled: ['example-layer'],
      subjects: [provider],
    });
    cockpit.syncEntry();
    return { cockpit, entered: cockpit.enter() };
  };
  const { provider: base } = exampleSubject();
  // A candidate() that throws offers nothing.
  const noCandidate = entered({
    ...base,
    candidate: () => {
      throw new Error('candidate failed');
    },
  });
  assert.equal(noCandidate.entered, false);
  assert.equal(noCandidate.cockpit.resolveEntry(), null);
  // An isEntryAllowed() that throws, or answers anything but true, shuts
  // the gate.
  for (const isEntryAllowed of [
    () => {
      throw new Error('gate failed');
    },
    () => 1,
    () => 'yes',
    () => ({}),
  ]) {
    const gated = entered({ ...base, isEntryAllowed });
    assert.equal(gated.entered, false, String(isEntryAllowed));
    assert.equal(gated.cockpit.active, false);
  }
  // A release() that throws still ends the view.
  const { provider } = exampleSubject();
  const releasing = entered({
    ...provider,
    release: () => {
      throw new Error('release failed');
    },
  });
  assert.equal(releasing.entered, true);
  assert.equal(releasing.cockpit.exit(), true);
  assert.equal(releasing.cockpit.active, false);
  assert.equal(document.body.classList.contains('cockpit-subject'), false);
  for (const method of ['candidate', 'isEntryAllowed', 'release'])
    assert.ok(
      warned.some((line) => line.includes(`${method}() failed`)),
      method,
    );
});

test('a malformed provider is left out and the built-in kinds are unchanged', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { cockpit } = fixture(t, {
    enabled: ['flights'],
    tracked: { layerId: 'flights', info: CIVIL },
    subjects: [{ kind: 'aircraft', layerId: 'flights' }],
  });
  assert.deepEqual(cockpit.subjectProviders, []);
  cockpit.syncEntry();
  assert.equal(cockpit.enter(), true);
  assert.equal(cockpit.subjectKind, 'aircraft');
});
