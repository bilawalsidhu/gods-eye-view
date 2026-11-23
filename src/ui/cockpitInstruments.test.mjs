// src/ui/cockpitInstruments.test.mjs — the Cockpit HUD's instruments, flight
// plan and vision selector render what the Cockpit controller presents, over
// happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { setLocale } from '../i18n/index.js';
import {
  createInstrumentState,
  createRouteState,
} from './cockpitInstrumentState.js';
import {
  clearPredictiveRoute,
  publishInstrumentsView,
  publishRouteView,
  setVisionMode,
  updateHud,
  updateRoute,
} from './cockpitInstruments.js';
import { useCockpitStore } from './stores/cockpit.js';
import CockpitView from './views/CockpitView.vue';

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(CockpitView).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  const store = useCockpitStore(pinia);
  const published = { instruments: 0, route: 0 };
  // The instrument presenters need only this much of the controller.
  const owner = {
    heading: null,
    surfaceAcquiring: false,
    surfaceFallback: false,
    lastContextUpdateMs: 0,
    instruments: createInstrumentState(),
    routeView: createRouteState(),
    routeSignature: null,
    publishInstruments: (view) => {
      published.instruments += 1;
      store.publishInstruments(view);
    },
    publishRoute: (view) => {
      published.route += 1;
      store.publishRoute(view);
    },
    publishVision: (view) => store.publishVision(view),
    publishInstrumentsView,
    publishRouteView,
    updateRoute,
    clearPredictiveRoute,
    // The briefing and Contact card have their own tests.
    updateLocalPosition() {},
    maybeRefreshRegionalBrief() {},
    updateContext() {},
  };
  const $ = (selector) => document.querySelector(selector);
  const text = (selector) => $(selector).textContent.trim();
  const ticks = (kind) => [
    ...document.querySelectorAll(`[data-${kind}-rim-tick]`),
  ];
  return { $, text, ticks, owner, published, store };
}

const INFO = Object.freeze({
  callsign: 'UAL123',
  velocityMps: 128.6,
  altitudeM: 3000,
  track: 92,
  latitude: 30.1975,
  longitude: -97.6664,
  layerId: 'flights',
});

const ROUTED = Object.freeze({
  ...INFO,
  route: {
    origin: { code: 'AUS', name: 'Austin' },
    destination: { code: 'DEN', name: 'Denver', lat: 39.86, lon: -104.67 },
  },
});

test('before the controller presents, the HUD shows the state it starts in', (t) => {
  const { $, text, ticks } = fixture(t);
  assert.equal(text('#cockpit-callsign'), 'AIRCRAFT');
  assert.equal(text('#cockpit-aircraft-meta'), 'LIVE TRACK · COURSE ALIGNED');
  assert.equal(text('#cockpit-speed-value'), '---');
  assert.equal(text('#cockpit-altitude-value'), '-----');
  assert.equal(text('#cockpit-heading-value'), '---');
  assert.equal($('#cockpit-speed-value').hasAttribute('aria-label'), false);
  assert.equal(text('#cockpit-speed-rim-value'), '---');
  assert.equal(text('#cockpit-altitude-rim-value'), '-----');
  assert.equal(text('#cockpit-clock'), '--:--:--Z');
  assert.equal(text('#cockpit-position'), '--° · --°');
  assert.equal($('#cockpit-compass-tape').children.length, 0);
  assert.equal(ticks('speed').length, 9);
  assert.equal(ticks('altitude').length, 9);
  assert.equal(
    ticks('speed').every((tick) => !tick.hidden && !tick.getAttribute('style')),
    true,
  );
  assert.equal($('#cockpit-route').hidden, true);
  assert.equal($('#cockpit-route-direction').hidden, true);
  assert.equal(text('#cockpit-route-direction-label'), 'DEST ---°');
  assert.equal($('#cockpit-hud').hasAttribute('data-layer'), false);
  const vision = $('#cockpit-vision-current');
  assert.equal(vision.dataset.cockpitVision, 'optical');
  assert.equal(text('#cockpit-vision-current-label'), 'NORMAL');
  assert.equal(
    vision.getAttribute('aria-label'),
    'Current cockpit vision style: Normal. Activate for next style.',
  );
});

test('a HUD update renders every readout', async (t) => {
  const { $, text, ticks, owner } = fixture(t);
  updateHud.call(owner, INFO, 1000, true);
  await nextTick();
  assert.equal(text('#cockpit-callsign'), 'UAL123');
  assert.equal(
    text('#cockpit-aircraft-meta'),
    'COMMERCIAL · LIVE TRACK · COURSE ALIGNED',
  );
  // 128.6 m/s is 250 kt; 3000 m is 9,843 ft; the track is the heading.
  const speed = $('#cockpit-speed-value');
  assert.equal(speed.tagName, 'STRONG');
  assert.equal(speed.getAttribute('aria-label'), '250');
  assert.equal(speed.textContent, '250');
  assert.equal(
    [...speed.children].every(
      (glyph) =>
        glyph.className === 'cockpit-roll-token' &&
        glyph.getAttribute('aria-hidden') === 'true',
    ),
    true,
  );
  assert.equal(text('#cockpit-altitude-value'), '9,843');
  assert.equal(
    $('#cockpit-altitude-value').children[1].className,
    'cockpit-roll-token is-separator',
  );
  assert.equal(text('#cockpit-heading-value'), '092');
  assert.equal(text('#cockpit-speed-rim-value'), '250');
  const placed = ticks('speed').filter((tick) => !tick.hidden);
  assert.equal(placed.length, 9);
  assert.match(placed[0].style.getPropertyValue('--slot'), /^-?\d+\.\d{4}$/);
  assert.match(placed[0].style.getPropertyValue('--curve'), /^-?\d+\.\d{5}$/);
  assert.equal(
    placed.some((tick) => tick.classList.contains('major')),
    true,
  );
  assert.equal(
    placed.every((tick) => tick.querySelector('b').textContent !== ''),
    true,
  );
  const compass = [...$('#cockpit-compass-tape').children];
  assert.deepEqual(
    compass.map((division) => division.textContent),
    ['N', '030', '060', 'E', '120', '150', 'S'],
  );
  assert.equal(compass[3].className, 'active');
  assert.equal(compass[0].style.getPropertyValue('--slot'), '-3');
  assert.equal(compass[0].style.getPropertyValue('--depth'), '3');
  assert.match(text('#cockpit-clock'), /^\d\d:\d\d:\d\dZ$/);
  assert.equal(text('#cockpit-position'), '30.198°N · 97.666°W');
  assert.equal($('#cockpit-hud').dataset.layer, 'flights');
});

test('a missing speed hides the rim ticks where they stood and marks the rim', async (t) => {
  const { $, ticks, owner } = fixture(t);
  updateHud.call(owner, INFO, 1000, true);
  await nextTick();
  const slot = ticks('speed')[0].style.getPropertyValue('--slot');
  updateHud.call(owner, { ...INFO, velocityMps: null }, 1100, true);
  await nextTick();
  assert.equal($('#cockpit-speed-rim').classList.contains('unavailable'), true);
  assert.equal(
    ticks('speed').every((tick) => tick.hidden),
    true,
  );
  assert.equal(ticks('speed')[0].style.getPropertyValue('--slot'), slot);
  assert.equal(
    $('#cockpit-altitude-rim').classList.contains('unavailable'),
    false,
  );
});

/** Stand in for the clock the odometer readouts throttle on. */
function stubClock(t, startMs = 1000) {
  let nowMs = startMs;
  t.mock.method(performance, 'now', () => nowMs);
  return (ms) => {
    nowMs += ms;
  };
}

const faster = (velocityMps) => ({ ...INFO, velocityMps });

test('a changed reading rolls its digits in fresh glyphs', async (t) => {
  const advance = stubClock(t);
  const { $, owner } = fixture(t);
  updateHud.call(owner, INFO, 1000, true);
  await nextTick();
  const before = $('#cockpit-speed-value').firstElementChild;
  // 10 kt faster, outside the throttle.
  advance(300);
  updateHud.call(owner, faster(133.75), 1300);
  await nextTick();
  const speed = $('#cockpit-speed-value');
  assert.equal(speed.getAttribute('aria-label'), '260');
  assert.equal(speed.firstElementChild === before, false);
  const rolling = speed.querySelectorAll('.is-rolling.roll-up');
  assert.equal(rolling.length, 1);
  assert.equal(
    rolling[0].querySelector('.cockpit-roll-track').textContent,
    '56',
  );
});

test('an unchanged reading keeps the glyphs, so a roll is not restarted', async (t) => {
  const advance = stubClock(t);
  const { $, owner } = fixture(t);
  updateHud.call(owner, INFO, 1000, true);
  await nextTick();
  advance(300);
  updateHud.call(owner, faster(133.75), 1300);
  await nextTick();
  const glyphs = [...$('#cockpit-speed-value').children];
  advance(100);
  updateHud.call(owner, faster(133.75), 1400);
  await nextTick();
  const after = [...$('#cockpit-speed-value').children];
  assert.equal(after.length, glyphs.length);
  assert.equal(
    after.every((glyph, index) => glyph === glyphs[index]),
    true,
  );
  assert.equal(after[1].classList.contains('is-rolling'), true);
});

test('a change inside the throttle is dropped, and every update restamps it', async (t) => {
  const advance = stubClock(t);
  const { $, owner } = fixture(t);
  const speed = () => $('#cockpit-speed-value').getAttribute('aria-label');
  updateHud.call(owner, INFO, 1000, true);
  await nextTick();
  // The same reading 150 ms later restamps the readout...
  advance(150);
  updateHud.call(owner, INFO, 1150);
  await nextTick();
  // ...so a change 200 ms after the first reading is still too soon.
  advance(50);
  updateHud.call(owner, faster(133.75), 1200);
  await nextTick();
  assert.equal(speed(), '250');
  // 220 ms after the restamp it shows.
  advance(170);
  updateHud.call(owner, faster(133.75), 1370);
  await nextTick();
  assert.equal(speed(), '260');
});

test('an emergency and a military track restyle the HUD', async (t) => {
  const { $, text, owner } = fixture(t);
  updateHud.call(
    owner,
    {
      ...INFO,
      layerId: 'military',
      emergency: {
        source: 'squawk',
        squawk: '7700',
        label: 'General emergency',
        severity: 'emergency',
      },
    },
    1000,
    true,
  );
  await nextTick();
  const meta = $('#cockpit-aircraft-meta');
  assert.match(
    meta.textContent,
    /^MILITARY · SQUAWK 7700 · GENERAL EMERGENCY · LIVE TRACK$/,
  );
  assert.equal(meta.classList.contains('emergency'), true);
  assert.equal(meta.classList.contains('cockpit-aircraft-meta'), true);
  assert.equal($('#cockpit-hud').dataset.layer, 'military');
  updateHud.call(owner, INFO, 1100, true);
  await nextTick();
  assert.equal(meta.classList.contains('emergency'), false);
  assert.equal(text('#cockpit-aircraft-meta').startsWith('COMMERCIAL'), true);
});

test('re-renders keep the visibility and classes the controller publishes on the HUD', async (t) => {
  const { $, owner, store } = fixture(t);
  const hud = $('#cockpit-hud');
  store.publishPresence({ active: true, context: false });
  hud.classList.add('voice-highlight');
  hud.style.setProperty('--voice-glow', '1');
  store.publishUtilityLayout({
    top: '120px',
    maxHeight: null,
    expandedMaxHeight: null,
    primaryOnly: false,
    hideCollapsed: false,
  });
  $('#cockpit-speed-rim').classList.add('external');
  updateHud.call(owner, INFO, 1000, true);
  await nextTick();
  updateHud.call(owner, { ...INFO, velocityMps: null }, 1100, true);
  await nextTick();
  assert.equal(hud.hidden, false);
  assert.equal(hud.classList.contains('signals-active'), true);
  assert.equal(hud.classList.contains('voice-highlight'), true);
  assert.equal(hud.style.getPropertyValue('--voice-glow'), '1');
  // The utility strip's measured anchor renders from the store.
  assert.equal(hud.style.getPropertyValue('--cockpit-utility-top'), '120px');
  store.publishUtilityLayout(null);
  await nextTick();
  assert.equal(hud.style.getPropertyValue('--cockpit-utility-top'), '');
  assert.equal(hud.style.getPropertyValue('--voice-glow'), '1');
  assert.equal($('#cockpit-speed-rim').classList.contains('external'), true);
});

test('a route shows the flight plan and the destination arrow', async (t) => {
  const { $, text, owner } = fixture(t);
  updateHud.call(owner, ROUTED, 1000, true);
  await nextTick();
  assert.equal($('#cockpit-route').hidden, false);
  assert.equal(text('#cockpit-route-from'), 'AUS · Austin');
  assert.equal(text('#cockpit-route-to'), 'DEN · Denver');
  assert.equal(text('#cockpit-route-status'), 'ARROW · ESTIMATED DIRECTION');
  const arrow = $('#cockpit-route-direction');
  assert.equal(arrow.hidden, false);
  assert.match(
    arrow.style.getPropertyValue('--route-angle'),
    /^-?\d+\.\d\ddeg$/,
  );
  assert.match(text('#cockpit-route-direction-label'), /^DEST \d{3}°$/);
});

test('a route without a destination fix keeps the card and hides the arrow where it pointed', async (t) => {
  const { $, text, owner } = fixture(t);
  updateHud.call(owner, ROUTED, 1000, true);
  await nextTick();
  const angle = $('#cockpit-route-direction').style.getPropertyValue(
    '--route-angle',
  );
  updateHud.call(
    owner,
    {
      ...ROUTED,
      route: { origin: ROUTED.route.origin, destination: { code: 'DEN' } },
    },
    1100,
    true,
  );
  await nextTick();
  assert.equal($('#cockpit-route').hidden, false);
  assert.equal(text('#cockpit-route-status'), 'ROUTE DATA UNAVAILABLE');
  assert.equal(text('#cockpit-route-to'), 'DEN');
  const arrow = $('#cockpit-route-direction');
  assert.equal(arrow.hidden, true);
  assert.equal(arrow.style.getPropertyValue('--route-angle'), angle);
  updateHud.call(owner, INFO, 1200, true);
  await nextTick();
  assert.equal($('#cockpit-route').hidden, true);
});

test('an unchanged route publishes nothing new; the instruments publish every update', (t) => {
  const { owner, published } = fixture(t);
  updateHud.call(owner, ROUTED, 1000, true);
  updateHud.call(owner, ROUTED, 1100, true);
  assert.equal(published.route, 1);
  assert.equal(published.instruments, 2);
  owner.routeView.visible = false;
  clearPredictiveRoute.call(owner);
  assert.equal(published.route, 2);
});

test('the vision selector shows the mode the controller sets', async (t) => {
  const { $, text, owner } = fixture(t);
  const changes = [];
  owner.onVisionChange = (...args) => changes.push(args);
  owner.active = true;
  setVisionMode.call(owner, 'thermal', { revealParameters: true });
  await nextTick();
  const vision = $('#cockpit-vision-current');
  assert.equal(owner.visionMode, 'thermal');
  assert.equal(vision.dataset.cockpitVision, 'thermal');
  assert.equal(text('#cockpit-vision-current-label'), 'FLIR');
  assert.equal(
    vision.getAttribute('aria-label'),
    'Current cockpit vision style: Thermal. Activate for next style.',
  );
  assert.equal(vision.title, 'Current style: Thermal — click for next');
  assert.deepEqual(changes, [['thermal', true, { revealParameters: true }]]);
});

test('the HUD reads in the UI language', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('ru');
  const { $, text, owner } = fixture(t);
  assert.equal(text('#cockpit-callsign'), 'САМОЛЁТ');
  updateHud.call(owner, INFO, 1000, true);
  setVisionMode.call(owner, 'nvg');
  await nextTick();
  assert.equal(text('#cockpit-altitude-value'), '9\u00a0843');
  assert.equal(
    $('#cockpit-altitude-value').children[1].className,
    'cockpit-roll-token is-separator',
  );
  assert.match(text('#cockpit-position'), /с\. ш\./);
  assert.match(
    $('#cockpit-vision-current').getAttribute('aria-label'),
    /^Текущий/,
  );
});
