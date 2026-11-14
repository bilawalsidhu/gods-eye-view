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
import { getLocale, setLocale } from '../i18n/index.js';
import { COCKPIT_GROUND_WAIT_TIMEOUT_MS } from './cockpitPresentation.js';
import { COCKPIT_SUBJECT_LIFT_MPS } from '../cockpitMath.js';
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
  let trackedAircraftInfo = null;
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
      flightsLayer: { getTrackedInfo: () => trackedAircraftInfo },
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
    /** Track the fixture's aircraft as Live Flights does, or untrack it. */
    trackAircraft(info) {
      trackedAircraftInfo = info;
      viewer.trackedEntity = info ? aircraft : undefined;
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

/** The fixture's aircraft as Live Flights reports it once tracked. */
const TRACKED_AIRCRAFT = Object.freeze({
  icao24: 'abc123',
  callsign: 'UAL123',
  track: 92,
  latitude: LAT,
  longitude: LON,
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

test('a HUD view with no speed shows no speed readout; one with no value shows it unknown', async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider();
  ride.subject.hud = { ...HUD, speed: undefined };
  const { $, cockpit } = fixture(t, { providers: [ride] });
  cockpit.syncEntry();
  assert.equal(cockpit.enter(), true);
  await settle();
  assert.ok($('.cockpit-speed') === null, 'no speed readout');
  assert.ok($('#cockpit-speed-value') === null, 'no speed value');
  assert.ok($('#cockpit-heading-value') !== null, 'the heading stays');
  ride.subject.hud = { ...HUD, speed: { value: null, unit: 'km/h' } };
  clock.advance(1000);
  cockpit.update();
  await settle();
  assert.match($('.cockpit-speed').textContent, /---/);
  assert.match($('.cockpit-speed').textContent, /km\/h/);
});

test('a progress line is an image named by its summary, else hidden from assistive technology', async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider();
  ride.subject.hud = { ...HUD, progress: { ...HUD.progress, summary: '' } };
  const { $, cockpit } = fixture(t, { providers: [ride] });
  cockpit.syncEntry();
  assert.equal(cockpit.enter(), true);
  await settle();
  let progress = $('.cockpit-progress');
  assert.equal(progress.hasAttribute('role'), false);
  assert.equal(progress.hasAttribute('aria-label'), false);
  assert.equal(progress.getAttribute('aria-hidden'), 'true');
  ride.subject.hud = HUD;
  clock.advance(1000);
  cockpit.update();
  await settle();
  progress = $('.cockpit-progress');
  assert.equal(progress.getAttribute('role'), 'img');
  assert.equal(progress.getAttribute('aria-label'), HUD.progress.summary);
  assert.equal(progress.hasAttribute('aria-hidden'), false);
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
  // the eye is pushed out of the floor at once and its clearance eases in;
  // a view entered with groundClamp false stays inside (a clamp lifted
  // mid-ride lets the eye down gradually, below).
  setFloor(FLOOR_M + 200);
  clock.advance(16);
  cockpit.update();
  const lifted = shotHeight(shots);
  assert.ok(lifted >= FLOOR_M + 200 - 0.01, 'out of the floor at once');
  assert.ok(lifted < FLOOR_M + 200 + 1.5 - 0.01, 'the clearance eases in');
  for (let i = 0; i < 80; i += 1) {
    clock.advance(16);
    cockpit.update();
  }
  assert.ok(shotHeight(shots) >= FLOOR_M + 200 + 1.5 - 0.01, 'clamped');
  ride.subject.frame = { ...ride.subject.frame, groundClamp: false };
  cockpit.exit();
  cockpit.syncEntry();
  assert.equal(cockpit.enter(), true);
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

test('a ground clamp lifted mid-ride lets the eye down at the rate it came up', async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider();
  const { cockpit, shots, setFloor } = fixture(t, { providers: [ride] });
  cockpit.syncEntry();
  assert.equal(cockpit.enter(), true);
  clock.advance(16);
  cockpit.update();
  // The floor rises to the eye: its clearance eases in.
  setFloor(FLOOR_M + 3.5);
  for (let i = 0; i < 80; i += 1) {
    clock.advance(16);
    cockpit.update();
  }
  assert.ok(Math.abs(shotHeight(shots) - (FLOOR_M + 5)) < 0.01, 'clamped');
  // Into a structure: the lift goes at the same rate, not at once.
  ride.subject.frame = { ...ride.subject.frame, groundClamp: false };
  clock.advance(100);
  cockpit.update();
  assert.ok(
    Math.abs(
      shotHeight(shots) - (FLOOR_M + 5 - COCKPIT_SUBJECT_LIFT_MPS * 0.1),
    ) < 0.01,
    'eased out',
  );
  for (let i = 0; i < 12; i += 1) {
    clock.advance(100);
    cockpit.update();
  }
  assert.ok(
    Math.abs(shotHeight(shots) - (FLOOR_M + 3.5)) < 0.01,
    'inside the structure',
  );
});

test('a subject updated every 500 ms turns, eases and closes on its target at its rates', async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider({ cameraIntervalMs: 500, headingSlewDps: 10 });
  ride.subject.frame = {
    ...ride.subject.frame,
    anchor: 'inertial',
    speedMps: 0,
  };
  const { cockpit, shots, setFloor } = fixture(t, { providers: [ride] });
  cockpit.syncEntry();
  assert.equal(cockpit.enter(), true);
  clock.advance(500);
  cockpit.update();
  assert.ok(Math.abs(shotHeight(shots) - (FLOOR_M + 3.5)) < 0.01);
  // One 500 ms update: the subject turns, the floor rises to the eye and the
  // frame moves 100 m east of the anchor. Each rate advances by the 0.5 s,
  // five times the 0.1 s a frame's step is capped at.
  ride.subject.frame = {
    ...ride.subject.frame,
    headingDeg: 180,
    longitude: LON + 100 / (111_320 * Math.cos(Cesium.Math.toRadians(LAT))),
  };
  setFloor(FLOOR_M + 3.5);
  clock.advance(500);
  cockpit.update();
  assert.ok(Math.abs(cockpit.heading - 95) < 1e-6, 'heading 10°/s × 0.5 s');
  assert.ok(
    Math.abs(
      shotHeight(shots) - (FLOOR_M + 3.5 + COCKPIT_SUBJECT_LIFT_MPS * 0.5),
    ) < 0.01,
    'lift 1.5 m/s × 0.5 s',
  );
  const ground = (shot) => {
    const at = Cesium.Cartographic.fromCartesian(shot.destination);
    return Cesium.Cartesian3.fromRadians(at.longitude, at.latitude, 0);
  };
  const closedM = Cesium.Cartesian3.distance(
    ground(shots.at(-1)),
    ground(shots.at(-2)),
  );
  // A standing subject's anchor closes at the correction's 0.75 m/s.
  assert.ok(Math.abs(closedM - 0.75 * 0.5) < 0.01, 'anchor 0.75 m/s × 0.5 s');
  // A long stall (a hidden tab) moves it as one late update would.
  clock.advance(60_000);
  cockpit.update();
  assert.ok(Math.abs(cockpit.heading - 101) < 1e-6, 'at most 0.6 s');
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
    // A frame whose getter throws runs provider code: as a malformed frame.
    Object.defineProperty(
      { id: 'a1', longitude: LON, eye: { upM: 2 } },
      'latitude',
      {
        get() {
          throw new Error('latitude unavailable');
        },
      },
    ),
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

test('entry fails when the gate is shut, the hold fails or no first frame comes, releasing only what it held', async (t) => {
  const shut = subjectProvider();
  shut.subject.allowed = false;
  let app = fixture(t, { providers: [shut] });
  app.cockpit.syncEntry();
  assert.equal(app.cockpit.enter(), false);
  assert.equal(
    shut.calls.some(([name]) => name === 'hold' || name === 'release'),
    false,
    'a shut gate neither holds nor releases',
  );
  const blank = subjectProvider();
  blank.subject.frame = null;
  app = fixture(t, { providers: [blank] });
  app.cockpit.syncEntry();
  assert.equal(app.cockpit.enter(), false);
  assert.deepEqual(lastRelease(blank.calls), ['release', 'a1', false]);
  assert.equal(app.cockpit.active, false);
  // A hold that throws may have half happened: it is released.
  const thrown = subjectProvider({
    hold: (id) => {
      thrown.calls.push(['hold', id]);
      throw new Error('hold failed');
    },
  });
  app = fixture(t, { providers: [thrown] });
  app.cockpit.syncEntry();
  assert.equal(app.cockpit.enter(), false);
  assert.deepEqual(lastRelease(thrown.calls), ['release', 'a1', false]);
  assert.equal(app.warned.length, 1);
  // So is one that answers with a promise: provider methods are synchronous.
  const later = subjectProvider({
    hold: async () => true,
  });
  app = fixture(t, { providers: [later] });
  app.cockpit.syncEntry();
  assert.equal(app.cockpit.enter(), false);
  assert.deepEqual(lastRelease(later.calls), ['release', 'a1', false]);
  assert.match(app.warned[0], /returned a promise/);
});

test('a hold that answers false refuses entry; any answer but true or false warns once; each is released', async (t) => {
  for (const [answer, warns] of [
    [false, false],
    [undefined, true],
    [1, true],
    ['held', true],
  ]) {
    const ride = subjectProvider();
    ride.subject.hold = answer;
    const { cockpit, warned } = fixture(t, { providers: [ride] });
    const holdWarnings = () =>
      warned.filter((message) =>
        /example-kind hold\(\) must return true or false/.test(message),
      ).length;
    cockpit.syncEntry();
    assert.equal(cockpit.enter(), false, `hold answered ${String(answer)}`);
    assert.equal(cockpit.active, false);
    assert.deepEqual(lastRelease(ride.calls), ['release', 'a1', false]);
    assert.equal(holdWarnings(), warns ? 1 : 0);
    assert.equal(warned.length, warns ? 1 : 0, 'no other warning');
    // Once per provider and method.
    assert.equal(cockpit.enter(), false);
    assert.equal(holdWarnings(), warns ? 1 : 0);
    assert.equal(
      ride.calls.filter(([name]) => name === 'release').length,
      2,
      'released each time',
    );
  }
});

test('a class-based provider keeps its `this` from entry to release', async (t) => {
  manualClock(t, 10_000);
  const { frame } = subjectProvider().subject;
  class Ride {
    #word = 'RIDE';
    #held = null;
    calls = [];
    kind = 'example-kind';
    layerId = 'example-layer';
    entryFace() {
      return { icon: 'commute', label: this.#word };
    }
    get labels() {
      return {
        view: `${this.#word} view`,
        exit: 'Exit ride view',
        exitText: `EXIT ${this.#word}`,
      };
    }
    look() {
      return { aheadLabel: `Look ahead, ${this.#word}` };
    }
    candidate() {
      return { id: 'a1', name: `Example ${this.#word}` };
    }
    isEntryAllowed(candidate) {
      return this.#held === null && candidate.id === 'a1';
    }
    hold(id) {
      this.#held = id;
      this.calls.push(['hold', id]);
      return true;
    }
    read() {
      this.calls.push(['read', this.#held]);
      return this.#held ? { ...frame, id: this.#held } : null;
    }
    hud(view) {
      this.calls.push(['hud', view.id]);
      return { ...HUD, title: `${this.#word} ${view.id}` };
    }
    release(id, { restore }) {
      this.calls.push(['release', id, restore]);
      this.#held = null;
    }
  }
  const ride = new Ride();
  const { $, cockpit, warned } = fixture(t, {
    providers: [{ definition: ride }],
  });
  cockpit.syncEntry();
  await nextTick();
  assert.match($('#cockpit-entry').textContent, /RIDE/);
  $('#cockpit-entry').click();
  await settle();
  assert.equal(cockpit.active, true);
  assert.equal($('#cockpit-callsign').textContent, 'RIDE a1');
  assert.equal($('#cockpit-hud').getAttribute('aria-label'), 'RIDE view');
  assert.match($('#map-view-switch').textContent, /EXIT RIDE/);
  assert.equal(
    $('#cockpit-look-ahead').getAttribute('aria-label'),
    'Look ahead, RIDE',
  );
  assert.ok(ride.calls.some(([name, id]) => name === 'read' && id === 'a1'));
  assert.ok(ride.calls.some(([name, id]) => name === 'hud' && id === 'a1'));
  $('#map-view-switch').click();
  assert.equal(cockpit.active, false);
  assert.deepEqual(lastRelease(ride.calls), ['release', 'a1', true]);
  assert.deepEqual(warned, []);
});

test('a frame with no height and a cold floor never stands the eye on the ellipsoid', async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider();
  ride.subject.frame = { ...ride.subject.frame, heightM: null };
  const { $, cockpit, shots, setFloor } = fixture(t, { providers: [ride] });
  // Nothing to stand on from the first frame: the camera waits where it is,
  // its HUD saying so and still read from the provider.
  setFloor(undefined);
  cockpit.syncEntry();
  assert.equal(cockpit.enter(), true);
  const before = shots.length;
  const huds = () => ride.calls.filter(([name]) => name === 'hud').length;
  const hudsBefore = huds();
  for (let i = 0; i < 5; i += 1) {
    clock.advance(200);
    cockpit.update();
  }
  await settle();
  assert.equal(shots.length, before, 'no camera placed');
  assert.equal(cockpit.active, true, 'the view waits');
  assert.ok(huds() > hudsBefore, 'the HUD is not frozen');
  assert.equal($('#cockpit-aircraft-meta').textContent, 'ACQUIRING SURFACE');
  assert.equal(
    $('#cockpit-aircraft-meta').getAttribute('data-tone'),
    'warning',
  );
  // The floor arrives: the eye stands on it.
  setFloor(FLOOR_M);
  clock.advance(16);
  cockpit.update();
  assert.ok(Math.abs(shotHeight(shots) - (FLOOR_M + 3.5)) < 0.01);
  // It goes cold again: the eye keeps the height it stood at, never 0 m,
  // with the ground clamp off too.
  setFloor(undefined);
  ride.subject.frame = { ...ride.subject.frame, groundClamp: false };
  for (let i = 0; i < 5; i += 1) {
    clock.advance(16);
    cockpit.update();
    assert.ok(Math.abs(shotHeight(shots) - (FLOOR_M + 3.5)) < 0.01);
  }
  // A height out of any plausible range reads as none.
  ride.subject.frame = { ...ride.subject.frame, heightM: -6_400_000 };
  clock.advance(16);
  cockpit.update();
  assert.ok(Math.abs(shotHeight(shots) - (FLOOR_M + 3.5)) < 0.01);
});

test('a floor that never comes ends the view after the bounded wait, releasing the subject', async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider();
  ride.subject.frame = { ...ride.subject.frame, heightM: null };
  const { $, cockpit, shots, setFloor } = fixture(t, { providers: [ride] });
  setFloor(undefined);
  cockpit.syncEntry();
  assert.equal(cockpit.enter(), true);
  const before = shots.length;
  // Acquiring, the HUD updating, for just under the wait...
  for (let elapsed = 0; elapsed < COCKPIT_GROUND_WAIT_TIMEOUT_MS - 250;) {
    clock.advance(250);
    elapsed += 250;
    cockpit.update();
  }
  await settle();
  assert.equal(cockpit.active, true);
  assert.equal($('#cockpit-aircraft-meta').textContent, 'ACQUIRING SURFACE');
  // ...then no guessed height: the view ends and the subject goes back.
  clock.advance(500);
  cockpit.update();
  assert.equal(cockpit.active, false);
  assert.equal(shots.length, before, 'never placed on a guess');
  assert.deepEqual(lastRelease(ride.calls), ['release', 'a1', false]);
});

test('an asynchronous hold that lands after entry was refused is released again', async (t) => {
  let heldId = null;
  const releases = [];
  const ride = subjectProvider({
    hold: async (id) => {
      await Promise.resolve();
      heldId = id;
      return true;
    },
    release: (id, options) => {
      releases.push([id, options.restore]);
      heldId = null;
    },
  });
  const { cockpit, warned } = fixture(t, { providers: [ride] });
  cockpit.syncEntry();
  assert.equal(cockpit.enter(), false, 'refused at once');
  assert.deepEqual(releases, [['a1', false]]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(heldId, null, 'the late hold is let go');
  assert.deepEqual(releases, [
    ['a1', false],
    ['a1', false],
  ]);
  assert.equal(cockpit.active, false);
  assert.match(warned[0], /hold\(\) returned a promise/);
});

test('a provider’s labels, entry face and look follow a change of language', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('en');
  const clock = manualClock(t, 10_000);
  const words = {
    en: { view: 'Ride view', exit: 'Exit ride view', exitText: 'EXIT RIDE' },
    de: {
      view: 'Fahrtansicht',
      exit: 'Fahrtansicht verlassen',
      exitText: 'VERLASSEN',
    },
  };
  const german = () => getLocale().startsWith('de');
  const ride = subjectProvider({
    labels: () => words[german() ? 'de' : 'en'],
    entryFace: () => ({ icon: 'commute', label: german() ? 'FAHRT' : 'RIDE' }),
    look: () => ({
      restPitchDeg: -3,
      aheadLabel: german() ? 'Nach vorn sehen' : 'Look ahead',
    }),
  });
  const { $, cockpit } = fixture(t, { providers: [ride] });
  cockpit.syncEntry();
  await nextTick();
  assert.match($('#cockpit-entry').textContent, /RIDE/);
  // On the entry, before the view.
  setLocale('de');
  await settle();
  assert.match($('#cockpit-entry').textContent, /FAHRT/);
  setLocale('en');
  await settle();
  assert.equal(cockpit.enter(), true);
  clock.advance(16);
  cockpit.update();
  await settle();
  assert.match($('#map-view-switch').textContent, /EXIT RIDE/);
  // While riding.
  setLocale('de');
  await settle();
  assert.match($('#map-view-switch').textContent, /VERLASSEN/);
  assert.equal(
    $('#map-view-switch').getAttribute('aria-label'),
    'Fahrtansicht verlassen',
  );
  assert.equal($('#cockpit-hud').getAttribute('aria-label'), 'Fahrtansicht');
  assert.equal(
    $('#cockpit-look-ahead').getAttribute('aria-label'),
    'Nach vorn sehen',
  );
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
  // So does a view whose getter throws when read.
  ride.subject.hud = Object.defineProperty({ ...HUD }, 'title', {
    get() {
      throw new Error('title unavailable');
    },
  });
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
  // The same subject selected again comes back to the front.
  clock.advance(500);
  ride.subject.candidate = { id: 'a1', name: 'Example 12', selectedAt: 2 };
  cockpit.syncEntry();
  assert.equal(store.presence.entryKind, 'example-kind', 're-selected');
  clock.advance(500);
  selectVessel({ ...VESSEL, id: '211000098', mmsi: '211000098' });
  cockpit.syncEntry();
  assert.equal(store.presence.entryKind, 'vessel');
  clock.advance(500);
  cockpit.syncEntry();
  assert.equal(store.presence.entryKind, 'vessel', 'an unchanged token');
  ride.subject.candidate = { id: 'a1', name: 'Example 12', selectedAt: 3 };
  cockpit.syncEntry();
  assert.equal(store.presence.entryKind, 'example-kind');
  // The newest decides alone: its shut gate leaves no entry.
  clock.advance(500);
  ride.subject.candidate = { id: 'a3', name: 'Example 3' };
  ride.subject.allowed = false;
  cockpit.syncEntry();
  assert.equal(store.presence.entryAvailable, false);
  assert.equal(cockpit.enter(), false);
});

test('the built-in kinds keep their order; a subject takes entry only when selected after all of them', async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider();
  ride.subject.candidate = null;
  const { cockpit, selectVessel, trackAircraft } = fixture(t, {
    providers: [ride],
  });
  trackAircraft(TRACKED_AIRCRAFT);
  cockpit.syncEntry();
  assert.equal(cockpit.resolveEntryKind(), 'aircraft');
  // A subject selected after the aircraft was tracked takes entry.
  clock.advance(500);
  ride.subject.candidate = { id: 'a1', name: 'Example 12' };
  cockpit.syncEntry();
  assert.equal(cockpit.resolveEntryKind(), 'example-kind');
  // A vessel selected after it: a built-in kind is newer, so the built-in
  // order decides, as without providers, and the aircraft comes first.
  clock.advance(500);
  selectVessel(VESSEL);
  cockpit.syncEntry();
  assert.equal(cockpit.resolveEntryKind(), 'aircraft');
  // The subject selected again is newer than every built-in one.
  clock.advance(500);
  ride.subject.candidate = { id: 'a1', name: 'Example 12', selectedAt: 2 };
  cockpit.syncEntry();
  assert.equal(cockpit.resolveEntryKind(), 'example-kind');
  // An aircraft tracked after it takes entry back.
  selectVessel(null);
  trackAircraft(null);
  cockpit.syncEntry();
  clock.advance(500);
  trackAircraft(TRACKED_AIRCRAFT);
  cockpit.syncEntry();
  assert.equal(cockpit.resolveEntryKind(), 'aircraft');
});

test('a new id under the same selectedAt is not a new selection', async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider();
  ride.subject.candidate = { id: 'a1', name: 'Example 12', selectedAt: 1 };
  const { cockpit, trackAircraft } = fixture(t, { providers: [ride] });
  cockpit.syncEntry();
  assert.equal(cockpit.resolveEntryKind(), 'example-kind');
  // An aircraft tracked after it takes entry.
  clock.advance(500);
  trackAircraft(TRACKED_AIRCRAFT);
  cockpit.syncEntry();
  assert.equal(cockpit.resolveEntryKind(), 'aircraft');
  // The selection moves to another copy of the same subject: same token.
  clock.advance(500);
  ride.subject.candidate = { id: 'b1', name: 'Example 12', selectedAt: 1 };
  cockpit.syncEntry();
  assert.equal(cockpit.resolveEntryKind(), 'aircraft');
  // A new token is a new selection.
  clock.advance(500);
  ride.subject.candidate = { id: 'b1', name: 'Example 12', selectedAt: 2 };
  cockpit.syncEntry();
  assert.equal(cockpit.resolveEntryKind(), 'example-kind');
  // Without a token, a new id is a new selection.
  clock.advance(500);
  trackAircraft(null);
  cockpit.syncEntry();
  trackAircraft(TRACKED_AIRCRAFT);
  cockpit.syncEntry();
  assert.equal(cockpit.resolveEntryKind(), 'aircraft');
  clock.advance(500);
  ride.subject.candidate = { id: 'c1', name: 'Example 3' };
  cockpit.syncEntry();
  assert.equal(cockpit.resolveEntryKind(), 'example-kind');
});

test('a subject first seen together with a built-in one comes after it', async (t) => {
  manualClock(t, 10_000);
  const ride = subjectProvider();
  const { cockpit, store } = fixture(t, { providers: [ride], vessel: VESSEL });
  cockpit.syncEntry();
  assert.equal(cockpit.resolveEntryKind(), 'vessel');
  assert.equal(store.presence.entryKind, 'vessel');
});

test("a double-click on the selected vessel does not enter an application's subject", async (t) => {
  const clock = manualClock(t, 10_000);
  const ride = subjectProvider();
  ride.subject.candidate = null;
  const { cockpit, store, viewer } = fixture(t, {
    providers: [ride],
    vessel: VESSEL,
  });
  cockpit.syncEntry();
  // The application's subject is selected after the vessel: it takes entry.
  clock.advance(500);
  ride.subject.candidate = { id: 'a1', name: 'Example 12', selectedAt: 1 };
  cockpit.syncEntry();
  assert.equal(cockpit.resolveEntryKind(), 'example-kind');
  // Every world position lands under the pointer, the vessel's sprite too.
  viewer.scene.cartesianToCanvasCoordinates = (_position, result = {}) =>
    Object.assign(result, { x: 400, y: 300 });
  assert.equal(cockpit.onSceneDoubleClick({ x: 400, y: 300 }), false);
  await settle();
  assert.notEqual(store.presence.active, true);
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
