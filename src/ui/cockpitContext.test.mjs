// src/ui/cockpitContext.test.mjs — the Cockpit Contact card renders what the
// Cockpit controller presents, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { setLocale, t as translate } from '../i18n/index.js';
import {
  publishContextView,
  showContextCard,
  updateContext,
} from './cockpitContext.js';
import { createContextState } from './cockpitContextState.js';
import { syncWeatherToggle } from './cockpitInstruments.js';
import { setContextCollapsed } from './cockpitLayout.js';
import { useCockpitStore } from './stores/cockpit.js';
import CockpitContext from './views/panels/CockpitContext.vue';

function fixture(t, snapshot = null) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(CockpitContext).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  const store = useCockpitStore(pinia);
  const $ = (selector) => document.querySelector(selector);
  const signals = [];
  const layouts = [];
  // The Contact presenter needs only this much of the controller.
  const owner = {
    context: $('#cockpit-context'),
    presence: { context: false },
    contextView: createContextState(),
    contextLayoutStamp: null,
    publishContext: (view) => store.publishContext(view),
    publishContextView,
    publishPresenceView: () => store.publishPresence({ ...owner.presence }),
    showContextCard,
    pushCockpitSignal: (...args) => signals.push(args),
    updateCockpitSignals() {},
    scheduleContextLayout: () => layouts.push(true),
    services: {
      militaryAwarenessLayer: { getContextSnapshot: () => owner.snapshot },
      formatAwarenessLabel: (item) => item?.id ?? '—',
    },
    snapshot,
  };
  const text = (selector) => $(selector).textContent.trim();
  return { $, text, owner, signals, layouts };
}

const INFO = {
  layerId: 'flights',
  icao24: 'abc123',
  latitude: 30,
  longitude: -97,
};

const snapshot = (overrides = {}) => ({
  subject: { layerId: 'military', id: 'm1', label: 'RCH123' },
  radiusM: 250_000,
  evaluatedAt: Date.UTC(2026, 9, 31, 12, 34, 56),
  navigation: { canPrevious: false, canNext: true },
  cohorts: [
    {
      id: 'flights',
      label: 'Flights',
      count: 12,
      relationship: 'OBSERVED',
      nearest: [{ id: 'N1', distanceM: 4200 }],
    },
    {
      id: 'military',
      label: 'Military',
      count: null,
      relationship: 'UNKNOWN',
      nearest: [],
    },
  ],
  ...overrides,
});

test('before the controller presents, the card shows the state it starts in', (t) => {
  const { $, text } = fixture(t);
  const card = $('#cockpit-context');
  assert.equal(card.hidden, true);
  assert.equal(card.hasAttribute('data-state'), false);
  assert.equal(text('#cockpit-context-subject'), 'CONTACTS · 250 KM');
  assert.equal($('#cockpit-context-previous').disabled, false);
  assert.equal($('#cockpit-context-next').disabled, false);
  assert.deepEqual(
    [...document.querySelectorAll('[data-context-cohort] strong')].map(
      (count) => count.textContent,
    ),
    ['—', '—', '—', '—'],
  );
  assert.equal(text('#cockpit-context-nearest-label'), 'NO AVAILABLE EXAMPLE');
  assert.equal(
    $('#cockpit-context-nearest-label').hasAttribute('aria-label'),
    false,
  );
  assert.equal($('#cockpit-context-direction').getAttribute('style'), null);
  assert.equal(
    text('#cockpit-context-uncertainty'),
    'AVAILABLE INPUTS ONLY · NOT AN ALL-CLEAR',
  );
  assert.equal(text('#cockpit-context-updated'), '--:--:--Z');
  const weather = $('#cockpit-weather-toggle');
  assert.equal(weather.getAttribute('aria-pressed'), 'false');
  assert.equal(
    weather.getAttribute('aria-label'),
    'Enable cockpit weather effects',
  );
  assert.equal(weather.title, 'Enable cockpit weather effects');
  assert.equal(text('#cockpit-weather-state'), 'OFF');
});

test('a snapshot fills the card and keeps classes other code sets', async (t) => {
  const { $, text, owner, layouts } = fixture(t, snapshot());
  const flights = $('[data-context-cohort="flights"]');
  flights.classList.add('voice-highlight');
  updateContext.call(owner, INFO, 0);
  await nextTick();
  const card = $('#cockpit-context');
  assert.equal(card.hidden, false);
  assert.equal(card.dataset.state, 'uncertain');
  assert.equal(owner.presence.context, true);
  assert.match(
    text('#cockpit-context-subject'),
    /^RCH123 · 250\u00a0KM AIR\/SEA WINDOW$/,
  );
  assert.equal($('#cockpit-context-previous').disabled, true);
  assert.equal($('#cockpit-context-next').disabled, false);
  assert.equal(flights.querySelector('strong').textContent, '12');
  assert.equal(flights.classList.contains('unknown'), false);
  assert.equal(flights.classList.contains('voice-highlight'), true);
  const military = $('[data-context-cohort="military"]');
  assert.equal(military.querySelector('strong').textContent, '?');
  assert.equal(military.classList.contains('unknown'), true);
  assert.equal(text('#cockpit-context-nearest-label'), 'FLIGHTS · N1');
  assert.equal(
    $('#cockpit-context-nearest-label').getAttribute('aria-label'),
    'FLIGHTS · N1',
  );
  assert.match(text('#cockpit-context-distance'), /^4\.2/);
  // The tracked aircraft is not the subject: the nose-relative half dashes.
  assert.equal(text('#cockpit-context-bearing'), 'BRG —');
  const direction = $('#cockpit-context-direction');
  assert.equal(direction.style.transform, 'rotate(0deg)');
  assert.equal(direction.classList.contains('unknown'), true);
  assert.equal(direction.classList.contains('material-symbols-outlined'), true);
  assert.equal(
    text('#cockpit-context-uncertainty'),
    '1 INPUT UNKNOWN · NOT AN ALL-CLEAR',
  );
  assert.equal(text('#cockpit-context-updated'), '12:34:56Z');
  assert.equal(layouts.length, 1);
});

test('a lost contact holds its readout behind the CONTACT LOST cue', async (t) => {
  const { $, text, owner, layouts } = fixture(t, snapshot());
  updateContext.call(owner, INFO, 0);
  await nextTick();
  const readout = () =>
    [
      '#cockpit-context-nearest-label',
      '#cockpit-context-distance',
      '#cockpit-context-bearing',
      '#cockpit-context-updated',
    ].map(text);
  const held = readout();
  owner.snapshot = snapshot({
    subjectPresent: false,
    navigation: { canPrevious: true, canNext: false },
    cohorts: [{ id: 'flights', label: 'Flights', count: 1, nearest: [] }],
  });
  updateContext.call(owner, INFO, 0);
  updateContext.call(owner, INFO, 0);
  await nextTick();
  assert.equal($('#cockpit-context').dataset.state, 'lost');
  assert.equal(
    text('#cockpit-context-uncertainty'),
    'CONTACT LOST · LAST KNOWN READOUT · NOT AN ALL-CLEAR',
  );
  // Navigation follows the lost snapshot; the readout holds.
  assert.deepEqual(readout(), held);
  assert.equal($('#cockpit-context-previous').disabled, false);
  assert.equal($('#cockpit-context-next').disabled, true);
  assert.equal($('[data-context-cohort="flights"] strong').textContent, '12');
  // Layout reruns once on the way in, not every update.
  assert.equal(layouts.length, 2);
});

test('without a snapshot the card stands by, hidden', async (t) => {
  const { $, owner, signals } = fixture(t, snapshot());
  updateContext.call(owner, INFO, 0);
  owner.snapshot = null;
  updateContext.call(owner, INFO, 0);
  await nextTick();
  assert.equal($('#cockpit-context').hidden, true);
  assert.equal(owner.presence.context, false);
  assert.equal(signals.at(-1)[2], 'CONTEXT STANDBY');
});

test('the weather toggle renders its state and the action it offers', async (t) => {
  const { $, text, owner } = fixture(t);
  syncWeatherToggle.call(owner, true);
  await nextTick();
  const weather = $('#cockpit-weather-toggle');
  assert.equal(weather.getAttribute('aria-pressed'), 'true');
  assert.equal(
    weather.getAttribute('aria-label'),
    'Disable cockpit weather effects',
  );
  assert.equal(weather.title, 'Disable cockpit weather effects');
  assert.equal(text('#cockpit-weather-state'), 'ON');
  assert.equal(owner.contextView.weather, true);
});

test('re-renders keep the collapse the controller presents and leave it the layout', async (t) => {
  const { $, owner } = fixture(t, snapshot());
  updateContext.call(owner, INFO, 0);
  const card = $('#cockpit-context');
  owner.presence.contextCollapsed = true;
  owner.publishPresenceView();
  card.dataset.layoutMode = 'compact-bottom';
  owner.snapshot = snapshot({ evaluatedAt: Date.UTC(2026, 9, 31, 12, 35) });
  updateContext.call(owner, INFO, 0);
  await nextTick();
  assert.equal(card.hidden, false);
  assert.equal(card.dataset.collapsed, 'true');
  assert.equal(card.dataset.layoutMode, 'compact-bottom');
  const toggle = $('#cockpit-context-toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), 'Expand Contact panel');
  assert.equal(toggle.title, 'Expand contact panel');
  assert.equal(toggle.textContent.trim(), 'chevron_right');
});

test('the card is labelled in the UI language', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('ru');
  const { $, text, owner } = fixture(t);
  const subject = translate('CONTACTS · 250 KM');
  assert.notEqual(subject, 'CONTACTS · 250 KM');
  assert.equal(text('#cockpit-context-subject'), subject);
  assert.equal(text('#cockpit-weather-state'), translate('OFF'));
  syncWeatherToggle.call(owner, true);
  await nextTick();
  assert.equal(text('#cockpit-weather-state'), translate('ON'));
  assert.equal(
    $('#cockpit-weather-toggle').getAttribute('aria-label'),
    translate('Disable cockpit weather effects'),
  );
});

test('collapsing the card publishes once per change', async (t) => {
  const { $, owner } = fixture(t);
  let published = 0;
  const publish = owner.publishPresenceView;
  Object.assign(owner, {
    contextCollapsed: false,
    presence: { context: true, contextCollapsed: false },
    publishPresenceView: () => {
      published += 1;
      publish();
    },
  });
  setContextCollapsed.call(owner, true);
  setContextCollapsed.call(owner, true);
  assert.equal(published, 1);
  await nextTick();
  assert.equal($('#cockpit-context').dataset.collapsed, 'true');
  assert.equal(
    $('#cockpit-context-toggle').getAttribute('aria-expanded'),
    'false',
  );
});
