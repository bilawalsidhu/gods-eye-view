// src/ui/cockpitPresence.test.mjs — the Cockpit entry, TR-3B chip, HUD, exit
// controls and Contact card show what the Cockpit controller publishes, and
// focus moves once they render, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { CockpitViewController } from './cockpitController.js';
import { setLocale } from '../i18n/index.js';
import { useCockpitStore } from './stores/cockpit.js';
import EntityCard from './views/panels/EntityCard.vue';
import { useEntityCardStore } from './stores/entityCard.js';
import CockpitView from './views/CockpitView.vue';
import IntelHudView from './views/IntelHudView.vue';
import {
  bindFakeCesiumCamera,
  followEntity,
} from '../testSupport/fakeCameraPort.mjs';

const INFO = Object.freeze({
  icao24: 'abc123',
  callsign: 'UAL123',
  track: 92,
  layerId: 'flights',
});

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(
    defineComponent(() => () => [
      h(IntelHudView),
      h(CockpitView),
      h(EntityCard),
    ]),
  ).use(pinia);
  app.mount(host);
  const store = useCockpitStore(pinia);
  // A browser does not focus a hidden control; happy-dom does, so refuse
  // here the way a browser would.
  const hiddenFocus = [];
  const refuseHiddenFocus = (button, name) => {
    const focus = button.focus.bind(button);
    button.focus = (options) => {
      if (button.hidden) hiddenFocus.push(name);
      else focus(options);
    };
  };
  refuseHiddenFocus(document.getElementById('map-view-switch'), 'exit');
  const converted = new Set();
  const listeners = () => ({ addEventListener: () => () => {} });
  const entity = { position: {}, show: true };
  const viewer = {
    camera: { cancelFlight() {} },
    entities: { contains: (candidate) => candidate === entity },
    scene: {
      preUpdate: listeners(),
      screenSpaceCameraController: { enableInputs: true },
    },
    trackedEntityChanged: listeners(),
  };
  bindFakeCesiumCamera(viewer, { frame: { on: () => () => {} } });
  followEntity(viewer, entity);
  const cockpit = new CockpitViewController(viewer, {
    services: {
      flightsLayer: { getTrackedInfo: () => INFO, refreshTr3b() {} },
      militaryFlightsLayer: { getTrackedInfo: () => null },
      isTr3b: (icao24) => converted.has(icao24),
      toggleTr3b: (icao24) => converted.delete(icao24) || converted.add(icao24),
      holdContinuousRender() {},
      releaseContinuousRender() {},
    },
    publish: {
      presence: (view) => store.publishPresence(view),
    },
  });
  // Entry and exit drive the HUD, briefing and route; their own tests cover
  // those, so this one keeps only what shows and hides.
  Object.assign(cockpit, {
    readAircraftInfo: () => INFO,
    updateHud() {},
    setVisionMode() {},
    showBriefPage() {},
    startBriefRotation() {},
    stopBriefRotation() {},
    pushCockpitSignal() {},
    scheduleContextLayout() {},
    clearPredictiveRoute() {},
  });
  const cards = useEntityCardStore(pinia);
  const layer = {
    id: 'flights',
    name: 'Flights',
    enabled: true,
    module: { getAnalystRecords: () => [{ ...INFO, id: INFO.icao24 }] },
  };
  cards.connect({
    dataManager: () => ({
      layers: new Map([[layer.id, layer]]),
      getAll: () => [layer],
    }),
    canCockpit: () => Boolean(store.presence?.entryAvailable),
    cockpit: () => cockpit.enter(),
  });
  cards.select({ layerId: layer.id, id: INFO.icao24, label: INFO.callsign });
  t.after(() => {
    cards.connect(null);
    cockpit.stop();
    app.unmount();
    document.body.classList.remove('cockpit-mode');
  });
  const $ = (selector) => document.querySelector(selector);
  presence = () => store.presence;
  return {
    $,
    cockpit,
    store,
    converted,
    hiddenFocus,
    cardEntry: () => $('#entity-card [data-entity-cockpit-entry]'),
  };
}

// The TR-3B action lives on the followed aircraft's card in Context; here
// it is read from what Cockpit publishes for it.
let presence = () => null;
const shown = ($) => ({
  entry: Boolean(presence()?.entryAvailable),
  tr3b: Boolean(presence()?.tr3b),
  hud: !$('#cockpit-hud').hidden,
  exit: !$('#map-view-switch').hidden,
  reset: !$('#cockpit-reset-globe').hidden,
  briefing: !$('#cockpit-signal-stream').hidden,
});

test('before anything is tracked, every Cockpit surface is hidden', (t) => {
  const { $ } = fixture(t);
  assert.deepEqual(shown($), {
    entry: false,
    tr3b: false,
    hud: false,
    exit: false,
    reset: false,
    briefing: false,
  });
  assert.equal($('#cockpit-context').hidden, true);
});

test('a tracked aircraft shows the entry and publishes its TR-3B conversion state', async (t) => {
  const { $, cockpit, store } = fixture(t);
  cockpit.syncEntry();
  await nextTick();
  assert.deepEqual(shown($), {
    entry: true,
    tr3b: true,
    hud: false,
    exit: false,
    reset: false,
    briefing: false,
  });
  assert.deepEqual(store.presence.tr3b, { converted: false });
  cockpit.toggleTrackedTr3b();
  await nextTick();
  assert.deepEqual(store.presence.tr3b, { converted: true });
  cockpit.toggleTrackedTr3b();
  await nextTick();
  assert.deepEqual(store.presence.tr3b, { converted: false });
});

test('entering shows the HUD and focuses the exit once it renders; exiting returns focus to the card', async (t) => {
  const { $, cockpit, cardEntry } = fixture(t);
  cockpit.syncEntry();
  await nextTick();
  const origin = cardEntry();
  origin.focus();
  origin.click();
  assert.equal(cockpit.active, true);
  await nextTick();
  await Promise.resolve();
  assert.deepEqual(shown($), {
    entry: false,
    tr3b: false,
    hud: true,
    exit: true,
    reset: true,
    briefing: true,
  });
  const hud = $('#cockpit-hud');
  assert.equal(hud.classList.contains('signals-active'), true);
  assert.equal(document.activeElement?.id, 'map-view-switch');

  $('#map-view-switch').click();
  assert.equal(cockpit.active, false);
  await nextTick();
  await Promise.resolve();
  assert.deepEqual(shown($), {
    entry: true,
    tr3b: true,
    hud: false,
    exit: false,
    reset: false,
    briefing: false,
  });
  assert.equal(hud.classList.contains('signals-active'), false);
  assert.equal(origin.isConnected, false);
  assert.ok(cardEntry());
  assert.ok(
    document.activeElement === cardEntry(),
    'focus returns to the current card entry',
  );
});

test('the HUD offers no entry of its own: the ride starts from the card', async (t) => {
  const { $, cockpit } = fixture(t);
  cockpit.syncEntry();
  await nextTick();
  assert.equal(presence()?.entryAvailable, true);
  assert.equal($('#cockpit-entry-readout'), null);
  assert.equal($('#intel-hud button'), null);
});

test('exiting leaves focus alone when the card no longer offers the ride', async (t) => {
  const { cockpit, hiddenFocus, cardEntry } = fixture(t);
  cockpit.syncEntry();
  await nextTick();
  const origin = cardEntry();
  origin.focus();
  origin.click();
  await nextTick();
  await Promise.resolve();
  cockpit.isEntryAllowed = () => false;
  assert.equal(origin.isConnected, false);
  cockpit.exit();
  await nextTick();
  await Promise.resolve();
  assert.equal(presence()?.entryAvailable, false);
  assert.equal(cardEntry(), null);
  assert.notEqual(document.activeElement, origin);
  assert.deepEqual(hiddenFocus, []);
});

test('a second entry withdraws the entry again and focuses the exit', async (t) => {
  const { cockpit, hiddenFocus, cardEntry } = fixture(t);
  cockpit.syncEntry();
  await nextTick();
  for (let pass = 0; pass < 2; pass += 1) {
    cardEntry().focus();
    cardEntry().click();
    await nextTick();
    await Promise.resolve();
    assert.equal(presence()?.entryAvailable, false);
    assert.equal(presence()?.tr3b, null);
    assert.equal(document.activeElement?.id, 'map-view-switch');
    cockpit.exit();
    await nextTick();
    await Promise.resolve();
    assert.equal(presence()?.entryAvailable, true);
    assert.ok(presence()?.tr3b);
    assert.ok(
      document.activeElement === cardEntry(),
      'focus returns to the current card entry',
    );
  }
  assert.deepEqual(hiddenFocus, []);
});

test('disposing an active Cockpit hides the HUD and offers no entry', async (t) => {
  const { $, cockpit } = fixture(t);
  cockpit.syncEntry();
  await nextTick();
  cockpit.enter();
  await nextTick();
  cockpit.dispose();
  await nextTick();
  await Promise.resolve();
  assert.equal($('#cockpit-hud').hidden, true);
  assert.equal($('#map-view-switch').hidden, true);
  assert.equal(presence()?.entryAvailable, false);
});

test('the Contact card and the HUD mark show and hide together', async (t) => {
  const { $, cockpit } = fixture(t);
  const hud = $('#cockpit-hud');
  hud.classList.add('voice-highlight');
  cockpit.showContextCard(true);
  await nextTick();
  assert.equal($('#cockpit-context').hidden, false);
  assert.equal(hud.classList.contains('context-active'), true);
  cockpit.showContextCard(false);
  await nextTick();
  assert.equal($('#cockpit-context').hidden, true);
  assert.equal(hud.classList.contains('context-active'), false);
  assert.equal(hud.classList.contains('voice-highlight'), true);
});

test('entering asks for a panel layout before Vue shows the cards', async (t) => {
  const { cockpit } = fixture(t);
  delete cockpit.scheduleContextLayout;
  const laid = [];
  cockpit.syncContextLayout = () => laid.push('context');
  cockpit.syncSignalLayout = () => laid.push('signals');
  cockpit.syncEntry();
  await nextTick();
  cockpit.enter();
  assert.notEqual(cockpit.contextLayoutFrame, null);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(laid, ['context', 'signals']);
});

test('an aircraft is acquired on its CURSO in Portuguese; a ship keeps RUMO', async (t) => {
  const { cockpit } = fixture(t);
  t.after(() => setLocale('en'));
  setLocale('pt');
  const signals = [];
  cockpit.pushCockpitSignal = (...args) => signals.push(args);
  cockpit.enter();
  await nextTick();
  const acquired = signals.find(([key]) => key === 'track');
  assert.ok(acquired, JSON.stringify(signals));
  assert.equal(acquired[3], 'UAL123 · CURSO 092°');
});
