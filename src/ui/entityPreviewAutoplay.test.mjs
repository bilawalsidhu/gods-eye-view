// src/ui/entityPreviewAutoplay.test.mjs — the card's top image takes its
// views in turn, each for six seconds once drawn; Pause, or picking a view,
// stops the turns, and a new item starts paused on the first view.
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../testSupport/vueDom.mjs';

let mount;
let createPinia;
let EntityPreview;
let uninstall;
let HERO_AUTOPLAY_MS;
let HERO_READY_WAIT_MS;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  ({ createPinia } = await import('pinia'));
  EntityPreview = (await import('./views/panels/EntityPreview.vue')).default;
  ({ HERO_AUTOPLAY_MS, HERO_READY_WAIT_MS } =
    await import('./entityHeroViews.js'));
});
after(() => uninstall());

const realMatchMedia = globalThis.matchMedia;
afterEach(() => {
  globalThis.matchMedia = realMatchMedia;
});

const STUBS = {
  AircraftModelHero: true,
  CctvPreview: true,
  StreetViewHero: true,
  CloseUpMap: true,
  FlightCockpitView: true,
  FeedDot: true,
  RouteGlobe: true,
  SatelliteGroundView: true,
};

// A tracked airliner with a photo and a known route: Photo, Route, Cockpit
// and Map (no fleet model set is loaded here).
function flight(key = 'flight-1', extra = {}) {
  return {
    key,
    kind: 'aircraft',
    layerId: 'flights',
    identity: { id: key },
    lat: 51.47,
    lon: -0.45,
    heading: 90,
    altitudeM: 10000,
    route: {
      fromAt: { code: 'LHR', lat: 51.47, lon: -0.45 },
      toAt: { code: 'JFK', lat: 40.64, lon: -73.78 },
    },
    photo: { src: `http://localhost/${key}.jpg` },
    ...extra,
  };
}

test('switching to the phone shell restores the first view and stops playback', async () => {
  const { useDisplayStore } = await import('./stores/display.js');
  const pinia = createPinia();
  const wrapper = mountPreview(flight(), pinia);
  try {
    const first = shown(wrapper);
    await wrapper.get('button[aria-label="Route"]').trigger('click');
    await playButton(wrapper).trigger('click');
    useDisplayStore(pinia).publishPhoneShell({
      enabled: true,
      sheet: 'context',
      tabs: [],
    });
    await settle(wrapper);
    assert.deepEqual(shown(wrapper), first);
    assert.equal(playButton(wrapper).attributes('aria-label'), 'Play preview');
  } finally {
    wrapper.unmount();
  }
});

function mountPreview(card, pinia = createPinia(), stubs = STUBS) {
  return mount(EntityPreview, {
    props: { card, title: 'TEST' },
    global: { plugins: [pinia], stubs },
  });
}

const tick = () => new Promise((resolve) => queueMicrotask(resolve));
async function settle(wrapper) {
  await tick();
  await wrapper.vm.$nextTick();
}
const shown = (wrapper) =>
  wrapper
    .findAll('.entity-card__preview-switch button.active')
    .map((button) => button.attributes('aria-label') || button.text());
const playButton = (wrapper) => wrapper.find('.entity-card__preview-play');
// An aircraft's card starts paused: these tests press Play first, as a reader
// would, to watch its turns.
async function mountPlaying(card) {
  const wrapper = mountPreview(card);
  await settle(wrapper);
  const play = playButton(wrapper);
  if (play.exists() && play.attributes('aria-label') === 'Play preview') {
    await play.trigger('click');
    await settle(wrapper);
  }
  return wrapper;
}

async function photoLoads(wrapper) {
  wrapper
    .get('.entity-hero__photo img')
    .element.dispatchEvent(new Event('load'));
  await settle(wrapper);
}

test('the views take turns once Play is pressed, each once drawn, round to the first', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const wrapper = await mountPlaying(flight());
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Photos'], 'the first view leads');
  const play = playButton(wrapper);
  assert.equal(play.attributes('aria-label'), 'Pause preview');
  assert.equal(
    play.attributes('aria-pressed'),
    undefined,
    'its name says what it does; it is not also a pressed toggle',
  );
  assert.equal(play.text(), 'pause');

  // The photo has not loaded: its six seconds have not started.
  context.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Photos']);
  await photoLoads(wrapper);
  context.mock.timers.tick(HERO_AUTOPLAY_MS - 1);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Photos']);
  context.mock.timers.tick(1);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Route']);

  // A mounted globe has not necessarily rendered its route yet.
  context.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Route']);
  wrapper.findComponent({ name: 'RouteGlobe' }).vm.$emit('ready');
  await settle(wrapper);
  context.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Cockpit view']);
  context.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Cockpit view'], 'still loading');
  wrapper.findComponent({ name: 'FlightCockpitView' }).vm.$emit('ready');
  await settle(wrapper);
  context.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Map']);

  // The map has drawn; then round to the photo again.
  wrapper.findComponent({ name: 'CloseUpMap' }).vm.$emit('state', 'ready');
  await settle(wrapper);
  context.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Photos'], 'after the last, the first');
  wrapper.unmount();
});

test('a view that never says it has drawn hands over after the longest wait', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const wrapper = await mountPlaying(flight());
  await settle(wrapper);
  context.mock.timers.tick(HERO_READY_WAIT_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Route']);
  wrapper.unmount();
});

test('Pause stops the turns and Play resumes them', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const wrapper = await mountPlaying(flight());
  await settle(wrapper);
  await photoLoads(wrapper);
  await playButton(wrapper).trigger('click');
  assert.equal(playButton(wrapper).attributes('aria-label'), 'Play preview');
  assert.equal(playButton(wrapper).attributes('aria-pressed'), undefined);
  assert.equal(playButton(wrapper).text(), 'play_arrow');
  context.mock.timers.tick(HERO_READY_WAIT_MS * 2);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Photos'], 'paused, it stays');

  await playButton(wrapper).trigger('click');
  assert.equal(playButton(wrapper).attributes('aria-label'), 'Pause preview');
  context.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Route']);
  wrapper.unmount();
});

test('picking a view shows it and pauses the turns there', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const wrapper = mountPreview(flight());
  await settle(wrapper);
  await wrapper.get('button[aria-label="Map"]').trigger('click');
  assert.deepEqual(shown(wrapper), ['Map']);
  assert.equal(playButton(wrapper).attributes('aria-label'), 'Play preview');
  context.mock.timers.tick(HERO_READY_WAIT_MS * 2);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Map'], 'the pick holds');
  wrapper.unmount();
});

test('the map kept behind another view is told it is not shown, so it asks for no tiles', async () => {
  const wrapper = mountPreview(flight());
  await settle(wrapper);
  await wrapper.get('button[aria-label="Map"]').trigger('click');
  await settle(wrapper);
  const map = () => wrapper.findComponent({ name: 'CloseUpMap' });
  assert.equal(map().props('active'), true, 'shown');
  await wrapper.get('button[aria-label="Photos"]').trigger('click');
  await settle(wrapper);
  assert.ok(map().exists(), 'kept for a quick return');
  assert.equal(map().props('active'), false, 'held while the photo shows');
  await wrapper.get('button[aria-label="Map"]').trigger('click');
  await settle(wrapper);
  assert.equal(map().props('active'), true, 'shown again');
  wrapper.unmount();
});

test('another aircraft starts again on its first view, paused', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const wrapper = await mountPlaying(flight('flight-1'));
  await wrapper.get('button[aria-label="Route"]').trigger('click');
  assert.equal(playButton(wrapper).attributes('aria-label'), 'Play preview');

  await wrapper.setProps({ card: flight('flight-2') });
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Photos']);
  assert.equal(playButton(wrapper).attributes('aria-label'), 'Play preview');
  await photoLoads(wrapper);
  context.mock.timers.tick(HERO_AUTOPLAY_MS * 2);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Photos'], 'held on its first view');
  wrapper.unmount();
});

// Cards hold their first view until Play is pressed.
test('an aircraft card starts paused, held on its first view until Play', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const aircraft = mountPreview(flight());
  await settle(aircraft);
  assert.equal(playButton(aircraft).attributes('aria-label'), 'Play preview');
  await photoLoads(aircraft);
  context.mock.timers.tick(HERO_AUTOPLAY_MS * 2);
  await settle(aircraft);
  assert.deepEqual(shown(aircraft), ['Photos'], 'no turns until Play');
  aircraft.unmount();

  // The vessel/model counterpart is covered in contextPanel.test.mjs.
});

test('an item with one view has no turns and no Play/Pause', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  // A vessel's photo with no position and no model: the photo only.
  const wrapper = mountPreview({
    key: 'vessel-1',
    kind: 'vessel',
    layerId: 'ships',
    identity: { id: 'vessel-1' },
    photo: { src: 'http://localhost/vessel.jpg' },
  });
  await settle(wrapper);
  assert.equal(wrapper.find('.entity-hero__photo').exists(), true);
  assert.equal(wrapper.find('.entity-card__preview-switch').exists(), false);
  assert.equal(playButton(wrapper).exists(), false);
  wrapper.unmount();
});

test('reduced motion pauses running turns and removing the preference does not restart them', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = new Set();
  const motion = {
    matches: true,
    addEventListener: (name, listener) => listeners.add(listener),
    removeEventListener: (name, listener) => listeners.delete(listener),
  };
  globalThis.matchMedia = () => motion;
  const preferReducedMotion = (matches) => {
    motion.matches = matches;
    for (const listener of listeners) listener({ matches });
  };
  const wrapper = mountPreview(flight());
  await settle(wrapper);
  await photoLoads(wrapper);
  assert.equal(playButton(wrapper).attributes('aria-label'), 'Play preview');
  context.mock.timers.tick(HERO_READY_WAIT_MS * 2);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Photos']);

  // A new item starts paused as well.
  await wrapper.setProps({ card: flight('flight-2') });
  await settle(wrapper);
  assert.equal(playButton(wrapper).attributes('aria-label'), 'Play preview');
  preferReducedMotion(false);
  await settle(wrapper);
  await playButton(wrapper).trigger('click');
  await photoLoads(wrapper);
  assert.equal(playButton(wrapper).attributes('aria-label'), 'Pause preview');
  preferReducedMotion(true);
  await settle(wrapper);
  assert.equal(
    playButton(wrapper).attributes('aria-label'),
    'Play preview',
    'changing the preference pauses an open card',
  );
  preferReducedMotion(false);
  context.mock.timers.tick(HERO_AUTOPLAY_MS * 2);
  await settle(wrapper);
  assert.equal(
    playButton(wrapper).attributes('aria-label'),
    'Play preview',
    'only Play can restart',
  );
  assert.deepEqual(shown(wrapper), ['Photos']);
  wrapper.unmount();
  assert.equal(
    listeners.size,
    0,
    'the preference listener leaves with the preview',
  );
});

test('with reduced motion on, Play is unavailable on an aircraft and a satellite alike', async () => {
  globalThis.matchMedia = () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  });
  const satellite = {
    key: 'sat-1',
    kind: 'satellite',
    layerId: 'satellites',
    identity: { id: 'sat-1' },
    lat: 10,
    lon: 20,
    altitudeM: 500_000,
  };
  for (const card of [flight(), satellite]) {
    const wrapper = mountPreview(card);
    await settle(wrapper);
    const play = playButton(wrapper);
    assert.ok(play.exists(), `${card.kind} has Play`);
    assert.equal(play.attributes('disabled'), '', `${card.kind} Play is off`);
    await play.trigger('click');
    await settle(wrapper);
    assert.equal(
      playButton(wrapper).attributes('aria-label'),
      'Play preview',
      `${card.kind} stays paused`,
    );
    wrapper.unmount();
  }
});

test('no turns while the page is hidden', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let state = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  context.after(() => delete document.visibilityState);
  const wrapper = await mountPlaying(flight());
  await settle(wrapper);
  await photoLoads(wrapper);
  state = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  await settle(wrapper);
  context.mock.timers.tick(HERO_READY_WAIT_MS * 2);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Photos']);

  state = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await settle(wrapper);
  context.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Route'], 'shown again, the turn restarts');
  wrapper.unmount();
});

// Play/Pause ends the row on either reading direction: its hairline and its
// rounded corners are on the inline sides, so they mirror right to left.
test('Play/Pause sets itself off by logical sides that mirror in right to left', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(
    new URL('./styles/entity-card.css', import.meta.url),
    'utf8',
  );
  const rule =
    css.match(
      /\.entity-card__preview-switch \.entity-card__preview-play\s*\{([^}]*)\}/,
    )?.[1] || '';
  assert.match(rule, /border-inline-start:/);
  assert.match(rule, /border-start-end-radius:\s*5px/);
  assert.match(rule, /border-end-end-radius:\s*5px/);
  assert.doesNotMatch(rule, /border-(left|right)\b|border-radius:/);
});

// The route globe renders only while the preview plays, as the model does:
// shown but paused, it holds its last frame.
test('the route view renders only while the preview plays', async () => {
  const wrapper = mountPreview(flight());
  await settle(wrapper);
  await wrapper.get('button[aria-label="Route"]').trigger('click');
  await settle(wrapper);
  const route = () => wrapper.findComponent({ name: 'RouteGlobe' });
  assert.deepEqual(shown(wrapper), ['Route']);
  assert.equal(route().props('active'), false, 'shown but paused');
  await playButton(wrapper).trigger('click');
  await settle(wrapper);
  assert.equal(route().props('active'), true, 'playing');
  wrapper.unmount();
});

// Only the view on show takes the keyboard. The one fading out under the
// next, the one still drawing and those kept mounted out of sight are inert,
// so Tab never reaches a photo link or map credit that is going or gone.
const isInert = (wrapper, selector) => {
  const node = wrapper.find(selector).element;
  return node.inert === true || node.hasAttribute('inert');
};
function mountAttached(card) {
  const host = document.body.appendChild(document.createElement('div'));
  return mount(EntityPreview, {
    attachTo: host,
    props: { card, title: 'TEST' },
    global: { plugins: [createPinia()], stubs: STUBS },
  });
}
const withLink = (key = 'flight-1') =>
  flight(key, {
    photo: {
      src: `http://localhost/${key}.jpg`,
      link: `http://localhost/${key}`,
    },
  });

test('the view going out of sight and those not on show are inert', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const wrapper = await mountPlaying(withLink());
  await photoLoads(wrapper);
  assert.equal(isInert(wrapper, '.entity-hero__photo'), false, 'on show');
  context.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Route']);
  assert.ok(
    wrapper.find('.entity-hero__photo').classes().includes('is-behind'),
    'the photo fades out under the route',
  );
  assert.equal(isInert(wrapper, '.entity-hero__photo'), true, 'fading out');
  assert.equal(
    isInert(wrapper, 'route-globe-stub'),
    true,
    'still drawing over it',
  );
  context.mock.timers.tick(400);
  await settle(wrapper);
  assert.equal(isInert(wrapper, 'route-globe-stub'), false, 'drawn');
  assert.equal(isInert(wrapper, '.entity-hero__photo'), true, 'out of sight');
  wrapper.unmount();
});

test('keyboard focus in the view on show holds the turns until it leaves', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const wrapper = mountAttached(withLink());
  await settle(wrapper);
  await playButton(wrapper).trigger('click');
  await photoLoads(wrapper);
  const link = wrapper.get('.entity-hero__photo').element;
  link.focus();
  assert.equal(document.activeElement === link, true, 'the photo link');
  await settle(wrapper);
  context.mock.timers.tick(HERO_AUTOPLAY_MS * 2);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Photos'], 'held while focused');
  assert.equal(document.activeElement === link, true, 'still on the link');

  playButton(wrapper).element.focus();
  await settle(wrapper);
  context.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Route'], 'the turns go on');
  wrapper.unmount();
});

test('a view that goes while focused hands the focus to the next view’s switch', async () => {
  const wrapper = mountAttached(withLink());
  await settle(wrapper);
  const link = wrapper.get('.entity-hero__photo').element;
  link.focus();
  assert.equal(document.activeElement === link, true, 'the photo link');
  // The photo fails to load: the route takes its place.
  wrapper
    .get('.entity-hero__photo img')
    .element.dispatchEvent(new Event('error'));
  await settle(wrapper);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Route']);
  const now = document.activeElement;
  assert.equal(
    now?.getAttribute?.('aria-label') || now?.tagName,
    'Route',
    'focus on the Route switch, not the page',
  );
  wrapper.unmount();
});

test('a failed photo hands focus from its removed switch to the Route switch', async (context) => {
  const wrapper = mountAttached(withLink());
  context.after(() => wrapper.unmount());
  await settle(wrapper);
  const photoSwitch = wrapper.get('button[aria-label="Photos"]').element;
  photoSwitch.focus();
  assert.equal(
    document.activeElement === photoSwitch,
    true,
    'the Photos switch has focus',
  );

  await wrapper.get('.entity-hero__photo img').trigger('error');
  await settle(wrapper);
  assert.equal(
    document.activeElement ===
      wrapper.get('button[aria-label="Route"]').element,
    true,
    'focus moves to the Route switch',
  );
});

test('a failed standalone photo hands focus to the tile when the map replaces it', async (context) => {
  const card = {
    ...withLink('vessel-1'),
    kind: 'vessel',
    layerId: 'ais-live-vessels',
  };
  const wrapper = mountAttached(card);
  context.after(() => wrapper.unmount());
  const link = wrapper.get('.entity-hero__photo').element;
  link.focus();
  assert.equal(
    document.activeElement === link,
    true,
    'the photo link has focus',
  );

  await wrapper.get('.entity-hero__photo img').trigger('error');
  await settle(wrapper);
  const tile = wrapper.get('.entity-hero[data-hero="map"]').element;
  assert.equal(
    document.activeElement === tile,
    true,
    'focus moves to the map tile',
  );
});

test('fleet bytes alone do not start the turn for an undrawn model', async (t) => {
  const { loadFleetModelSet, resetFleetModelSet } =
    await import('../data/fleetModels.js');
  const { fetchPublicFile } = await import('../testSupport/fleetGlb.mjs');
  await loadFleetModelSet({ fetchImpl: fetchPublicFile });
  t.after(resetFleetModelSet);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { useEntityCardStore } = await import('./stores/entityCard.js');
  const pinia = createPinia();
  let ready;
  useEntityCardStore(pinia).connect({
    previews: () => ({
      model(_host, _spec, events) {
        ready = events.onReady;
        return { setActive() {}, destroy() {} };
      },
    }),
  });
  const wrapper = mountPreview(
    flight('model-card', {
      photo: null,
      modelSubject: { fleet: 'aircraft', typeCode: 'B738' },
    }),
    pinia,
    { ...STUBS, AircraftModelHero: false },
  );
  t.after(() => wrapper.unmount());
  assert.deepEqual(shown(wrapper), ['3D']);
  const hud = () => wrapper.get('.preview-hud--model').classes();
  assert.ok(hud().includes('is-paused'));
  await playButton(wrapper).trigger('click');
  assert.ok(!hud().includes('is-paused'));
  t.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['3D']);
  ready();
  await settle(wrapper);
  t.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Cockpit view']);
});

test('an entirely failed map block waits; a fresh Map turn waits for its own draw', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wrapper = mountPreview(flight());
  t.after(() => wrapper.unmount());
  const mapButton = wrapper.get('button[aria-label="Map"]');
  await mapButton.trigger('click');
  await playButton(wrapper).trigger('click');
  const map = wrapper.findComponent({ name: 'CloseUpMap' });
  map.vm.$emit('state', 'failed');
  t.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Map']);

  map.vm.$emit('state', 'ready');
  await settle(wrapper);
  t.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Photos']);

  await mapButton.trigger('click');
  map.vm.$emit('entered', 'loading');
  await playButton(wrapper).trigger('click');
  t.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Map'], 'the new Map turn has not drawn');

  map.vm.$emit('state', 'ready');
  await settle(wrapper);
  t.mock.timers.tick(HERO_AUTOPLAY_MS);
  await settle(wrapper);
  assert.deepEqual(shown(wrapper), ['Photos']);
});

function mockVisibility(t) {
  let observe;
  const previous = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(fn) {
      observe = fn;
    }
    observe() {}
    disconnect() {}
  };
  t.after(() => {
    globalThis.IntersectionObserver = previous;
  });
  return (visible) => observe([{ isIntersecting: visible }]);
}

test('a hidden hero holds its map position until it is shown again', async (t) => {
  const visible = mockVisibility(t);
  const wrapper = mountPreview(flight(), createPinia(), {
    ...STUBS,
    CloseUpMap: false,
    CardMapCanvas: true,
  });
  t.after(() => wrapper.unmount());
  await wrapper.get('button[aria-label="Map"]').trigger('click');
  const canvas = () => wrapper.findComponent({ name: 'CardMapCanvas' });
  const position = () => [canvas().props('lat'), canvas().props('lon')];
  const initial = position();
  visible(false);
  await settle(wrapper);
  await wrapper.setProps({ card: flight('flight-1', { lat: 30, lon: -97 }) });
  assert.deepEqual(position(), initial);
  visible(true);
  await settle(wrapper);
  assert.deepEqual(position(), [30, -97]);
});

test('the cockpit draws a paused still and follows new positions only while visible and playing', async (t) => {
  const { useEntityCardStore } = await import('./stores/entityCard.js');
  const visible = mockVisibility(t);
  const pinia = createPinia();
  let ready;
  let active;
  let lat;
  useEntityCardStore(pinia).connect({
    previews: () => ({
      cockpit: (_host, initial, events) => {
        ready = events.onReady;
        lat = initial.lat;
        return {
          setActive(value) {
            active = value;
          },
          update(pose) {
            lat = pose.lat;
          },
          destroy() {},
        };
      },
    }),
  });
  const wrapper = mountPreview(flight(), pinia, {
    ...STUBS,
    FlightCockpitView: false,
  });
  t.after(() => wrapper.unmount());
  await wrapper.get('button[aria-label="Cockpit view"]').trigger('click');
  assert.equal(active, true, 'load the first still');
  ready();
  await settle(wrapper);
  assert.equal(active, false, 'stop once the paused still is ready');
  const move = (lat, heading) =>
    wrapper.setProps({ card: flight('flight-1', { lat, heading }) });
  await move(35, 184);
  assert.equal(lat, 51.47);
  assert.match(wrapper.get('.flight-cockpit__label').text(), /090°/);
  assert.match(wrapper.get('.flight-cockpit__label').text(), /Paused/);
  await playButton(wrapper).trigger('click');
  assert.equal(active, true);
  assert.equal(lat, 35);
  assert.match(wrapper.get('.flight-cockpit__label').text(), /184°/);
  assert.doesNotMatch(wrapper.get('.flight-cockpit__label').text(), /Paused/);
  visible(false);
  await settle(wrapper);
  await move(34, 250);
  assert.equal(active, false);
  assert.equal(lat, 35);
  visible(true);
  await settle(wrapper);
  assert.equal(active, true);
  assert.equal(lat, 34);
});
