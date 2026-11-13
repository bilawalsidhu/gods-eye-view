// src/ui/cockpitPresence.test.mjs — the Cockpit entry, TR-3B chip, HUD, exit
// controls and Contact card show what the Cockpit controller publishes, and
// focus moves once they render, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { CockpitViewController } from './cockpitController.js';
import { useCockpitStore } from './stores/cockpit.js';
import CockpitView from './views/CockpitView.vue';
import ContextView from './views/ContextView.vue';

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
    defineComponent(() => () => [h(ContextView), h(CockpitView)]),
  ).use(pinia);
  app.mount(host);
  const store = useCockpitStore(pinia);
  // A browser does not focus a hidden control; happy-dom does, so refuse
  // here the way a browser would.
  const hiddenFocus = [];
  for (const id of ['cockpit-entry', 'map-view-switch']) {
    const button = document.getElementById(id);
    const focus = button.focus.bind(button);
    button.focus = (options) => {
      if (button.hidden) hiddenFocus.push(id);
      else focus(options);
    };
  }
  const converted = new Set();
  const listeners = () => ({ addEventListener: () => () => {} });
  const entity = { position: {}, show: true };
  const viewer = {
    trackedEntity: entity,
    camera: { cancelFlight() {} },
    entities: { contains: (candidate) => candidate === entity },
    scene: {
      preUpdate: listeners(),
      screenSpaceCameraController: { enableInputs: true },
    },
    trackedEntityChanged: listeners(),
  };
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
  t.after(() => {
    cockpit.stop();
    app.unmount();
    document.body.classList.remove('cockpit-mode');
  });
  const $ = (selector) => document.querySelector(selector);
  return { $, cockpit, store, converted, hiddenFocus };
}

const shown = ($) => ({
  entry: !$('#cockpit-entry').hidden,
  tr3b: !$('#tr3b-toggle').hidden,
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

test('a tracked aircraft shows the entry and a TR-3B chip that names its action', async (t) => {
  const { $, cockpit } = fixture(t);
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
  const chip = $('#tr3b-toggle');
  assert.equal(chip.getAttribute('aria-pressed'), 'false');
  assert.equal(chip.title, 'Reclassify as TR-3B');
  chip.click();
  await nextTick();
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  assert.equal(chip.title, 'Restore real aircraft');
  // The static accessible name survives the re-render.
  assert.equal(
    chip.getAttribute('aria-label'),
    'Reclassify tracked contact as TR-3B',
  );
});

test('entering shows the HUD and focuses the exit once it renders; exiting returns focus to the entry', async (t) => {
  const { $, cockpit } = fixture(t);
  cockpit.syncEntry();
  await nextTick();
  const entry = $('#cockpit-entry');
  entry.focus();
  entry.click();
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
  assert.equal(document.activeElement?.id, 'cockpit-entry');
});

test('exiting leaves focus alone when the entry is no longer available', async (t) => {
  const { $, cockpit, hiddenFocus } = fixture(t);
  cockpit.syncEntry();
  await nextTick();
  $('#cockpit-entry').focus();
  cockpit.enter();
  await nextTick();
  await Promise.resolve();
  cockpit.isEntryAllowed = () => false;
  cockpit.exit();
  await nextTick();
  await Promise.resolve();
  assert.equal($('#cockpit-entry').hidden, true);
  assert.notEqual(document.activeElement?.id, 'cockpit-entry');
  assert.deepEqual(hiddenFocus, []);
});

test('a second entry hides the entry again and focuses the exit', async (t) => {
  const { $, cockpit, hiddenFocus } = fixture(t);
  cockpit.syncEntry();
  await nextTick();
  for (let pass = 0; pass < 2; pass += 1) {
    $('#cockpit-entry').focus();
    cockpit.enter();
    await nextTick();
    await Promise.resolve();
    assert.equal($('#cockpit-entry').hidden, true);
    assert.equal($('#tr3b-toggle').hidden, true);
    assert.equal(document.activeElement?.id, 'map-view-switch');
    cockpit.exit();
    await nextTick();
    await Promise.resolve();
    assert.equal($('#cockpit-entry').hidden, false);
    assert.equal($('#tr3b-toggle').hidden, false);
    assert.equal(document.activeElement?.id, 'cockpit-entry');
  }
  assert.deepEqual(hiddenFocus, []);
});

test('disposing an active Cockpit hides the HUD and leaves the entry hidden', async (t) => {
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
  assert.equal($('#cockpit-entry').hidden, true);
  assert.notEqual(document.activeElement?.id, 'cockpit-entry');
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
