// src/ui/cockpitSubjectView.test.mjs — an application provider's subject in
// the Cockpit: its entry face, the hold and release around the view, the
// frame that places the camera (eye height, ground clamp, exact anchor), the
// generic HUD it words, the most recent selection winning entry, and the
// ways the view ends. Over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, defineComponent, h, nextTick } from 'vue';
import * as Cesium from 'cesium';
import { CockpitViewController } from './cockpitController.js';
import { useCockpitStore } from './stores/cockpit.js';
import CockpitView from './views/CockpitView.vue';
import ContextView from './views/ContextView.vue';
import { cockpitSubjectProviders } from '../cockpitSubjectProviders.js';
import { vesselCockpitInfo } from '../layers/vessels/cockpitSubject.js';

const LAT = 47;
const LON = 8;
const FLOOR_M = 400;

/** A HUD view model as a provider words it. */
const HUD = Object.freeze({
  kicker: 'LINE 12 · OPERATOR',
  title: 'Example 12 → Terminus',
  meta: { text: 'LIVE TRACK · EYE 3.5 M', tone: 'live' },
  speed: { value: 84, unit: 'km/h', tag: 'LIVE', tone: 'live' },
  readouts: [
    {
      id: 'next',
      label: 'NEXT STOP',
      value: 'Central',
      detail: '14:32 · T−4 · +2 MIN',
      tone: 'normal',
    },
  ],
  sources: [{ id: 'track', label: 'TRACK', text: 'operator shape' }],
  route: { title: 'LINE', from: 'Origin', to: 'Terminus', status: '9 stops' },
  banner: { title: 'IN STRUCTURE', detail: '2.4 KM · OUT IN 1:30' },
  veil: { level: 0.8, streaks: true },
  progress: {
    ticks: [
      { at: 0, label: { text: 'Origin', align: 'start', priority: 1 } },
      { at: 0.5 },
      { at: 1, label: { text: 'Terminus', align: 'end', priority: 1 } },
    ],
    marker: { at: 0.25, dwell: false },
    tag: 'TIMETABLE',
    summary: 'Route progress: Origin to Terminus',
  },
  lookReadout: 'LOOK RIGHT 45°',
  signals: [{ id: 'note', title: 'NOTE', detail: 'a provider row' }],
});

/** A scriptable provider; `calls` records what the Cockpit asked of it. */
function subjectProvider(overrides = {}) {
  const calls = [];
  const subject = {
    candidate: { id: 'a1', name: 'Example 12' },
    frame: {
      id: 'a1',
      name: 'Example 12',
      latitude: LAT,
      longitude: LON,
      heightM: FLOOR_M,
      headingDeg: 90,
      speedMps: 20,
      groundClamp: true,
      anchor: 'exact',
      eye: { upM: 3.5, forwardM: 0, pitchDeg: -3, minClearanceM: 1.5 },
    },
    hud: HUD,
    allowed: true,
    hold: true,
  };
  const definition = {
    kind: 'example-kind',
    layerId: 'example-layer',
    priority: 1,
    entryFace: { icon: 'commute', label: 'RIDE' },
    labels: {
      view: 'Example ride view',
      exit: 'Exit example view',
      exitText: 'EXIT RIDE',
      kicker: 'RIDE',
    },
    look: { restPitchDeg: -3, aheadLabel: 'Look ahead along the line' },
    cameraIntervalMs: 0,
    headingSlewDps: Infinity,
    candidate: () => subject.candidate,
    isEntryAllowed: (candidate) => {
      calls.push(['allowed', candidate.id]);
      return subject.allowed;
    },
    hold: (id) => {
      calls.push(['hold', id]);
      return subject.hold;
    },
    read: (nowMs, ctx) => {
      calls.push(['read', typeof ctx.groundHeightAt]);
      if (subject.frame instanceof Error) throw subject.frame;
      return typeof subject.frame === 'function'
        ? subject.frame(ctx)
        : subject.frame;
    },
    hud: (frame, ctx) => {
      calls.push(['hud', frame.id, ctx.look.offset]);
      if (subject.hud instanceof Error) throw subject.hud;
      return subject.hud;
    },
    release: (id, options) => calls.push(['release', id, options.restore]),
    ...overrides,
  };
  return { definition, subject, calls };
}

function fixture(t, { providers = [], vessel = null, layerOn = true } = {}) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(
    defineComponent(() => () => [h(ContextView), h(CockpitView)]),
  ).use(pinia);
  app.mount(host);
  const store = useCockpitStore(pinia);
  const listeners = () => ({ addEventListener: () => () => {} });
  const shots = [];
  const aircraftPosition = Cesium.Cartesian3.fromDegrees(LON, LAT, 3000);
  const aircraft = {
    position: {
      getValue: (time, result) =>
        Cesium.Cartesian3.clone(aircraftPosition, result),
    },
    show: true,
    gevTrackedId: 'flights:abc123',
  };
  const viewer = {
    trackedEntity: undefined,
    clock: { currentTime: null },
    camera: {
      heading: 0,
      cancelFlight() {},
      setView({ destination, orientation }) {
        shots.push({
          destination: Cesium.Cartesian3.clone(destination),
          direction: Cesium.Cartesian3.clone(orientation.direction),
        });
      },
    },
    entities: { contains: (candidate) => candidate === aircraft },
    scene: {
      preUpdate: listeners(),
      screenSpaceCameraController: { enableInputs: true },
    },
    trackedEntityChanged: listeners(),
  };
  let vesselSelected = vessel;
  let floorM = FLOOR_M;
  const warned = [];
  t.mock.method(console, 'warn', (message) => warned.push(String(message)));
  const subjectProviders = cockpitSubjectProviders(
    providers.map((entry) => entry.definition),
  );
  const signals = [];
  const dropped = [];
  const cockpit = new CockpitViewController(viewer, {
    services: {
      flightsLayer: { getTrackedInfo: () => null },
      militaryFlightsLayer: { getTrackedInfo: () => null },
      aisLiveVesselsLayer: {
        getCockpitSubject: () =>
          vesselSelected
            ? { ...vesselCockpitInfo(vesselSelected), seaSurfaceHeightM: 0 }
            : null,
        setCockpitSubject: () => true,
      },
      militaryAwarenessLayer: {},
      isTr3b: () => false,
      holdContinuousRender() {},
      releaseContinuousRender() {},
      cachedGroundFloor: () => floorM,
      warmGroundFloor() {},
      GROUND_FLOOR_LIFT_M: 1.5,
    },
    isBridgeEntryAllowed: () => true,
    subjectProviders,
    isSubjectEntryAllowed: (provider, candidate) =>
      layerOn && provider.isEntryAllowed(candidate) === true,
    publish: {
      presence: (view) => store.publishPresence(view),
      instruments: (view) => store.publishInstruments(view),
      route: (view) => store.publishRoute(view),
      radar: (view) => store.publishRadar(view),
    },
  });
  Object.assign(cockpit, {
    setVisionMode() {},
    showBriefPage() {},
    startBriefRotation() {},
    stopBriefRotation() {},
    pushCockpitSignal(key, tone, title, detail) {
      signals.push({ key, tone, title, detail });
    },
    dropCockpitSignal(key) {
      dropped.push(key);
    },
    scheduleContextLayout() {},
    updateLocalPosition() {},
    maybeRefreshRegionalBrief() {},
    showContextCard() {},
  });
  t.after(() => {
    cockpit.stop();
    app.unmount();
    document.body.classList.remove(
      'cockpit-mode',
      'cockpit-subject',
      'cockpit-bridge',
    );
  });
  const $ = (selector) => document.querySelector(selector);
  return {
    $,
    cockpit,
    viewer,
    aircraft,
    store,
    shots,
    warned,
    signals,
    dropped,
    selectVessel(record) {
      vesselSelected = record;
    },
    setFloor(value) {
      floorM = value;
    },
  };
}

function manualClock(t, startMs) {
  const originalNow = performance.now;
  const originalDateNow = Date.now;
  let nowMs = startMs;
  performance.now = () => nowMs;
  Date.now = () => nowMs;
  t.after(() => {
    performance.now = originalNow;
    Date.now = originalDateNow;
  });
  return {
    advance(ms) {
      nowMs += ms;
    },
  };
}

async function settle() {
  await nextTick();
  await Promise.resolve();
}

/** The provider's last release call. */
const lastRelease = (calls) => calls.findLast(([name]) => name === 'release');

/** The camera's height above the ellipsoid in its last shot (m). */
const shotHeight = (shots) =>
  Cesium.Cartographic.fromCartesian(shots.at(-1).destination).height;

const VESSEL = Object.freeze({
  id: '211000000',
  mmsi: '211000000',
  name: 'NORDIC STAR',
  type: '70',
  lat: 54.5,
  lon: 10.2,
  speed: 12,
  course: 95,
  heading: 90,
  missedRefreshes: 0,
});

test('a provider candidate offers its own entry face; a shut gate hides it', async (t) => {
  const ride = subjectProvider();
  const { $, cockpit, store } = fixture(t, { providers: [ride] });
  cockpit.syncEntry();
  await nextTick();
  const entry = $('#cockpit-entry');
  assert.equal(entry.hidden, false);
  assert.match(entry.textContent, /commute/);
  assert.match(entry.textContent, /RIDE/);
  assert.equal(store.presence.entryKind, 'example-kind');
  // A candidate may bring its own face.
  ride.subject.candidate = {
    id: 'a2',
    name: 'Tram 4',
    face: { icon: 'tram', label: 'BOARD' },
  };
  cockpit.syncEntry();
  await nextTick();
  assert.match(entry.textContent, /tram/);
  assert.match(entry.textContent, /BOARD/);
  ride.subject.allowed = false;
  cockpit.syncEntry();
  await nextTick();
  assert.equal(entry.hidden, true, "the provider's own rule shuts entry");
  assert.equal(cockpit.enter(), false);
  ride.subject.allowed = true;
  ride.subject.candidate = null;
  cockpit.syncEntry();
  await nextTick();
  assert.equal(entry.hidden, true, 'no candidate, no entry');
});

test('entry holds the subject, takes the camera and shows the generic HUD', async (t) => {
  manualClock(t, 10_000);
  const ride = subjectProvider();
  const { $, cockpit, shots, store, signals } = fixture(t, {
    providers: [ride],
  });
  cockpit.syncEntry();
  await nextTick();
  $('#cockpit-entry').click();
  await settle();
  assert.equal(cockpit.active, true);
  assert.equal(cockpit.subjectKind, 'example-kind');
  assert.deepEqual(
    ride.calls.filter(([name]) => name === 'hold'),
    [['hold', 'a1']],
  );
  assert.ok(document.body.classList.contains('cockpit-subject'));
  assert.equal(store.presence.subjectGeneric, true);
  const hud = $('#cockpit-hud');
  assert.equal(hud.getAttribute('data-subject'), 'example-kind');
  assert.ok(hud.hasAttribute('data-generic'));
  assert.equal(hud.getAttribute('aria-label'), 'Example ride view');
  assert.equal(
    $('#map-view-switch').getAttribute('aria-label'),
    'Exit example view',
  );
  assert.match($('#map-view-switch').textContent, /EXIT RIDE/);
  // The provider's words, not the aircraft's.
  assert.equal($('.cockpit-kicker').textContent, HUD.kicker);
  assert.equal($('#cockpit-callsign').textContent, HUD.title);
  assert.equal($('#cockpit-aircraft-meta').getAttribute('data-tone'), 'live');
  assert.match($('.cockpit-speed').textContent, /84/);
  assert.match($('.cockpit-speed').textContent, /km\/h/);
  assert.match($('.cockpit-speed').textContent, /LIVE/);
  assert.equal($('.cockpit-scan-array'), null);
  assert.equal($('#cockpit-altitude-rim'), null);
  assert.equal($('#cockpit-speed-rim'), null);
  assert.equal($('.cockpit-roll-arc'), null);
  assert.equal($('.cockpit-reticle'), null);
  const card = $('[data-readout="next"]');
  assert.match(card.textContent, /NEXT STOP/);
  assert.match(card.textContent, /Central/);
  assert.match($('[data-source="track"]').textContent, /operator shape/);
  assert.match($('.cockpit-banner').textContent, /IN STRUCTURE/);
  const veil = $('.cockpit-veil');
  assert.equal(hud.firstElementChild, veil, 'the veil lies under the HUD');
  assert.ok(veil.classList.contains('streaks'));
  assert.equal(veil.style.opacity, '0.8');
  const progress = $('.cockpit-progress');
  assert.equal(
    progress.getAttribute('aria-label'),
    'Route progress: Origin to Terminus',
  );
  assert.equal(progress.querySelectorAll('.cockpit-progress-tick').length, 3);
  assert.match(progress.textContent, /Origin/);
  assert.match(progress.textContent, /TIMETABLE/);
  assert.ok(hud.hasAttribute('data-progress'));
  assert.match($('.cockpit-help').textContent, /ARROWS LOOK/);
  // The route card is titled by the provider, not as a flight plan.
  const route = $('#cockpit-route');
  assert.equal(route.hidden, false);
  assert.equal($('.cockpit-route-kicker', route).textContent, 'LINE');
  assert.equal(route.getAttribute('aria-label'), 'LINE');
  // TRACK ACQUIRED names the subject; the HUD view's rows reach Live Signals.
  assert.deepEqual(signals[0], {
    key: 'track',
    tone: 'track',
    title: 'TRACK ACQUIRED',
    detail: 'Example 12',
  });
  assert.ok(
    signals.some(
      (row) => row.key === 'subject:note' && row.detail === 'a provider row',
    ),
  );
  assert.ok(shots.length >= 1 || cockpit.lastSubjectFrame);
});

test('the eye stands its height above the frame, and the ground clamp can be lifted', async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider();
  const { cockpit, shots, setFloor } = fixture(t, { providers: [ride] });
  cockpit.syncEntry();
  assert.equal(cockpit.enter(), true);
  clock.advance(16);
  cockpit.update();
  assert.ok(Math.abs(shotHeight(shots) - (FLOOR_M + 3.5)) < 0.01);
  // Every frame updates (cameraIntervalMs 0).
  const before = shots.length;
  clock.advance(16);
  cockpit.update();
  assert.equal(shots.length, before + 1);
  // Inside a structure the frame stands below the rendered floor: clamped,
  // the eye is pushed up to the floor; with groundClamp false it stays.
  setFloor(FLOOR_M + 200);
  clock.advance(16);
  cockpit.update();
  assert.ok(shotHeight(shots) >= FLOOR_M + 200 + 1.5 - 0.01, 'clamped');
  ride.subject.frame = { ...ride.subject.frame, groundClamp: false };
  clock.advance(16);
  cockpit.update();
  assert.ok(
    Math.abs(shotHeight(shots) - (FLOOR_M + 3.5)) < 0.01,
    'not clamped',
  );
  // No height in the frame: the eye stands on the shared floor.
  setFloor(FLOOR_M);
  ride.subject.frame = { ...ride.subject.frame, heightM: null };
  clock.advance(16);
  cockpit.update();
  assert.ok(Math.abs(shotHeight(shots) - (FLOOR_M + 3.5)) < 0.01);
});

test('an exact anchor sits on the subject, wherever the frame moves it', async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider();
  const { cockpit, shots } = fixture(t, { providers: [ride] });
  cockpit.syncEntry();
  cockpit.enter();
  for (const step of [1, 2, 3]) {
    const longitude = LON + step * 0.001;
    ride.subject.frame = { ...ride.subject.frame, longitude };
    clock.advance(16);
    cockpit.update();
    const at = Cesium.Cartographic.fromCartesian(shots.at(-1).destination);
    assert.ok(
      Math.abs(Cesium.Math.toDegrees(at.longitude) - longitude) < 1e-7,
      `step ${step}`,
    );
  }
});

test('the view ends when the frame stops coming, and gives the subject back', async (t) => {
  const clock = manualClock(t, 10_000);
  for (const ending of [
    null,
    { latitude: LAT, longitude: LON, id: 'other', eye: { upM: 2 } },
  ]) {
    const ride = subjectProvider();
    const { cockpit } = fixture(t, { providers: [ride] });
    cockpit.syncEntry();
    assert.equal(cockpit.enter(), true);
    ride.subject.frame = ending;
    clock.advance(16);
    cockpit.update();
    assert.equal(cockpit.active, false);
    assert.deepEqual(lastRelease(ride.calls), ['release', 'a1', false]);
    assert.equal(document.body.classList.contains('cockpit-subject'), false);
  }
});

test('leaving by the exit control asks the provider to restore its subject', async (t) => {
  const ride = subjectProvider();
  const { $, cockpit } = fixture(t, { providers: [ride] });
  cockpit.syncEntry();
  cockpit.enter();
  await settle();
  $('#map-view-switch').click();
  assert.equal(cockpit.active, false);
  assert.deepEqual(lastRelease(ride.calls), ['release', 'a1', true]);
});

test('entry fails, releasing nothing it did not hold, when hold or the first frame fails', async (t) => {
  const refused = subjectProvider();
  refused.subject.hold = false;
  let app = fixture(t, { providers: [refused] });
  app.cockpit.syncEntry();
  assert.equal(app.cockpit.enter(), false);
  assert.equal(
    refused.calls.some(([name]) => name === 'release'),
    false,
  );
  const blank = subjectProvider();
  blank.subject.frame = null;
  app = fixture(t, { providers: [blank] });
  app.cockpit.syncEntry();
  assert.equal(app.cockpit.enter(), false);
  assert.deepEqual(lastRelease(blank.calls), ['release', 'a1', false]);
  assert.equal(app.cockpit.active, false);
});

test('a read that throws ends the view once; a hud that throws keeps the last', async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider();
  const { $, cockpit, warned } = fixture(t, { providers: [ride] });
  cockpit.syncEntry();
  cockpit.enter();
  await settle();
  ride.subject.hud = new Error('hud failed');
  clock.advance(200);
  cockpit.update();
  await settle();
  assert.equal(cockpit.active, true);
  assert.equal($('#cockpit-callsign').textContent, HUD.title, 'last view kept');
  ride.subject.frame = new Error('read failed');
  clock.advance(16);
  cockpit.update();
  assert.equal(cockpit.active, false);
  assert.equal(
    warned.filter((message) => /example-kind read\(\) failed/.test(message))
      .length,
    1,
  );
  assert.equal(
    warned.filter((message) => /example-kind hud\(\) failed/.test(message))
      .length,
    1,
  );
});

test('an aircraft tracked during the view ends it, never adopted', async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider();
  const { cockpit, viewer, aircraft } = fixture(t, { providers: [ride] });
  cockpit.syncEntry();
  cockpit.enter();
  viewer.trackedEntity = aircraft;
  assert.equal(cockpit._adoptTrackedEntity(performance.now()), false);
  clock.advance(16);
  cockpit.update();
  assert.equal(cockpit.active, false);
  assert.deepEqual(lastRelease(ride.calls), ['release', 'a1', false]);
  assert.equal(cockpit.navigateContext(1), false);
});

test('the most recently selected subject wins entry', async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider();
  ride.subject.candidate = null;
  const { cockpit, store, selectVessel } = fixture(t, {
    providers: [ride],
    vessel: VESSEL,
  });
  cockpit.syncEntry();
  assert.equal(store.presence.entryKind, 'vessel');
  // A subject selected after the vessel takes the entry.
  clock.advance(500);
  ride.subject.candidate = { id: 'a1', name: 'Example 12' };
  cockpit.syncEntry();
  assert.equal(store.presence.entryKind, 'example-kind');
  assert.equal(cockpit.resolveEntryKind(), 'example-kind');
  // Another vessel selected later takes it back.
  clock.advance(500);
  selectVessel({ ...VESSEL, id: '211000099', mmsi: '211000099' });
  cockpit.syncEntry();
  assert.equal(store.presence.entryKind, 'vessel');
  // The newest decides alone: its shut gate leaves no entry.
  clock.advance(500);
  ride.subject.candidate = { id: 'a3', name: 'Example 3' };
  ride.subject.allowed = false;
  cockpit.syncEntry();
  assert.equal(store.presence.entryAvailable, false);
  assert.equal(cockpit.enter(), false);
});

test('a provider view with look turns with the arrow keys and words its readout', async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider();
  const { $, cockpit } = fixture(t, { providers: [ride] });
  cockpit.syncEntry();
  cockpit.enter();
  await settle();
  assert.equal(cockpit.lookTarget.pitchDeg, -3, 'rests at its own pitch');
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
  );
  clock.advance(200);
  cockpit.update();
  await settle();
  assert.notEqual(cockpit.lookTarget.yawDeg, 0);
  assert.ok(ride.calls.some(([name, , offset]) => name === 'hud' && offset));
  assert.equal($('.cockpit-look').hidden, false);
  assert.equal($('#cockpit-look-readout').textContent, HUD.lookReadout);
  assert.equal(
    $('#cockpit-look-ahead').getAttribute('aria-label'),
    'Look ahead along the line',
  );
  // Without `look` the keys leave the view alone.
  const still = subjectProvider({ look: undefined });
  const other = fixture(t, { providers: [still] });
  other.cockpit.syncEntry();
  other.cockpit.enter();
  assert.equal(
    other.cockpit.turnLook({ axis: 'yaw', sign: 1, stepDeg: 15 }),
    false,
  );
});

test('rows a HUD view no longer lists leave Live Signals', async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider();
  const { cockpit, dropped } = fixture(t, { providers: [ride] });
  cockpit.syncEntry();
  cockpit.enter();
  ride.subject.hud = { ...HUD, signals: [] };
  clock.advance(1000);
  cockpit.update();
  assert.ok(dropped.includes('subject:note'));
});
