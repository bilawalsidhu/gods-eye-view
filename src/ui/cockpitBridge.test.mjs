// src/ui/cockpitBridge.test.mjs — a selected vessel's bridge view: entry,
// the vessel layer's sprite hold, the bridge readouts, refused contact
// navigation and the ways the bridge ends, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { CockpitViewController } from './cockpitController.js';
import { useCockpitStore } from './stores/cockpit.js';
import CockpitView from './views/CockpitView.vue';
import ContextView from './views/ContextView.vue';
import * as Cesium from 'cesium';
import { vesselCockpitInfo } from '../layers/vessels/cockpitSubject.js';
import { VesselRecords } from '../layers/vessels/records.js';

const RECORD = Object.freeze({
  mmsi: '211000000',
  name: 'NORDIC STAR',
  type: '70',
  destination: 'KIEL',
  lat: 54.5,
  lon: 10.2,
  speed: 12,
  course: 95,
  heading: 90,
  lastPositionEpoch: null,
  missedRefreshes: 0,
});

/** A ship 2 NM north of RECORD, inside the radar's default range. */
const NEIGHBOUR = Object.freeze({
  id: '211000001',
  name: 'BALTIC TERN',
  latitude: RECORD.lat + 2 / 60,
  longitude: RECORD.lon,
  course: 270,
  heading: 270,
  type: '30',
  color: '#ffd166',
  stale: false,
});

function vesselLayer(record) {
  const calls = [];
  const radarQueries = [];
  let selected = record;
  let subject = null;
  let enabled = true;
  return {
    calls,
    radarQueries,
    deselect() {
      selected = null;
    },
    /** Another ship selected in its place. */
    select(next) {
      selected = next;
    },
    /** Live AIS Vessels turned off: like the layer, it then has no subject. */
    disable() {
      enabled = false;
    },
    getCockpitSubject: () =>
      enabled && selected
        ? { ...vesselCockpitInfo(selected), seaSurfaceHeightM: 0 }
        : null,
    setCockpitSubject(mmsi) {
      calls.push(['subject', mmsi]);
      subject = mmsi;
      return true;
    },
    // Like the layer, leaves out the ship whose bridge the Cockpit rides.
    getRadarContacts(lat, lon, rangeM, maxCount) {
      radarQueries.push({ lat, lon, rangeM, maxCount });
      const own = {
        ...NEIGHBOUR,
        id: record.mmsi,
        latitude: record.lat,
        longitude: record.lon,
      };
      return [own, NEIGHBOUR].filter((contact) => contact.id !== subject);
    },
    focusSelectedVessel() {
      calls.push(['focus']);
      return true;
    },
  };
}

function fixture(
  t,
  { bridgeAllowed = true, record = RECORD, aircraftInfo = null } = {},
) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(
    defineComponent(() => () => [h(ContextView), h(CockpitView)]),
  ).use(pinia);
  app.mount(host);
  const store = useCockpitStore(pinia);
  const listeners = () => ({ addEventListener: () => () => {} });
  const aircraftPosition = Cesium.Cartesian3.fromDegrees(10.2, 54.5, 3000);
  const aircraft = {
    position: {
      getValue: (time, result) =>
        Cesium.Cartesian3.clone(aircraftPosition, result),
    },
    show: true,
    gevTrackedId: aircraftInfo ? `flights:${aircraftInfo.icao24}` : '',
  };
  const views = [];
  // Each placed camera: where it is and where it looks.
  const shots = [];
  const viewer = {
    trackedEntity: undefined,
    clock: { currentTime: null },
    camera: {
      cancelFlight() {},
      setView({ destination, orientation }) {
        views.push(Cesium.Cartesian3.clone(destination));
        shots.push({
          destination: Cesium.Cartesian3.clone(destination),
          direction: Cesium.Cartesian3.clone(orientation.direction),
          up: Cesium.Cartesian3.clone(orientation.up),
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
  const vessels = vesselLayer(record);
  const navigations = [];
  // Turning Live Flights off clears its tracking, as the layer does.
  let flightsEnabled = true;
  const disableFlights = () => {
    flightsEnabled = false;
  };
  const cockpit = new CockpitViewController(viewer, {
    services: {
      flightsLayer: {
        getTrackedInfo: () => (flightsEnabled ? aircraftInfo : null),
      },
      militaryFlightsLayer: { getTrackedInfo: () => null },
      aisLiveVesselsLayer: vessels,
      militaryAwarenessLayer: {
        navigateNext: () => navigations.push('next') > 0,
        navigatePrevious: () => navigations.push('previous') > 0,
      },
      isTr3b: () => false,
      holdContinuousRender() {},
      releaseContinuousRender() {},
      // Open water: no rendered floor above the sea surface.
      cachedGroundFloor: () => null,
      GROUND_FLOOR_LIFT_M: 0,
    },
    // The aircraft gate stays shut: the bridge must not depend on Contacts.
    isEntryAllowed: () => Boolean(aircraftInfo),
    isBridgeEntryAllowed: () => bridgeAllowed,
    publish: {
      presence: (view) => store.publishPresence(view),
      instruments: (view) => store.publishInstruments(view),
      route: (view) => store.publishRoute(view),
      radar: (view) => store.publishRadar(view),
    },
  });
  // The briefing and signals have their own tests; the bridge keeps only
  // what it shows and owns.
  Object.assign(cockpit, {
    setVisionMode() {},
    showBriefPage() {},
    startBriefRotation() {},
    stopBriefRotation() {},
    pushCockpitSignal() {},
    scheduleContextLayout() {},
    updateLocalPosition() {},
    maybeRefreshRegionalBrief() {},
  });
  // An aircraft session's Contact card and flight plan have their own tests.
  if (aircraftInfo)
    Object.assign(cockpit, { updateContext() {}, updateRoute() {} });
  t.after(() => {
    cockpit.stop();
    app.unmount();
    document.body.classList.remove('cockpit-mode');
  });
  const $ = (selector) => document.querySelector(selector);
  return {
    $,
    cockpit,
    viewer,
    vessels,
    aircraft,
    disableFlights,
    navigations,
    views,
    shots,
    store,
  };
}

/** Replace both clocks the bridge reads; returns a stepper and a restore. */
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
    set(ms) {
      nowMs = ms;
    },
  };
}

async function settle() {
  await nextTick();
  await Promise.resolve();
}

test('a selected vessel offers a BRIDGE entry without Contacts', async (t) => {
  const { $, cockpit } = fixture(t);
  cockpit.syncEntry();
  await nextTick();
  const entry = $('#cockpit-entry');
  assert.equal(entry.hidden, false);
  assert.match(entry.textContent, /directions_boat/);
  assert.match(entry.textContent, /BRIDGE/);
  assert.equal($('#tr3b-toggle').hidden, true, 'TR-3B stays aircraft-only');
});

test('a shut bridge gate keeps the entry hidden', async (t) => {
  const { $, cockpit } = fixture(t, { bridgeAllowed: false });
  cockpit.syncEntry();
  await nextTick();
  assert.equal($('#cockpit-entry').hidden, true);
  assert.equal(cockpit.enter(), false);
});

test('entering the bridge hides the vessel and shows bridge readouts', async (t) => {
  const { $, cockpit, vessels } = fixture(t);
  cockpit.syncEntry();
  await nextTick();
  $('#cockpit-entry').click();
  await settle();
  assert.equal(cockpit.active, true);
  assert.equal(cockpit.subjectKind, 'vessel');
  assert.deepEqual(vessels.calls, [['subject', RECORD.mmsi]]);
  assert.equal(document.body.classList.contains('cockpit-mode'), true);

  assert.equal(
    $('#cockpit-hud').getAttribute('aria-label'),
    'Ship bridge view',
  );
  assert.match($('.cockpit-kicker').textContent, /BRIDGE VIEW/);
  assert.equal($('#cockpit-callsign').textContent, 'NORDIC STAR');
  assert.match($('#cockpit-aircraft-meta').textContent, /CARGO · LIVE AIS/);
  assert.match($('#cockpit-aircraft-meta').textContent, /EYE 30/);
  assert.equal($('#cockpit-altitude-rim').hidden, true);
  assert.equal($('#cockpit-altitude-value'), null);
  assert.ok($('#cockpit-course-value'), 'course over ground replaces altitude');
  assert.match($('#map-view-switch').textContent, /EXIT BRIDGE/);
  assert.equal(
    $('#map-view-switch').getAttribute('aria-label'),
    'Exit bridge view',
  );

  const route = $('#cockpit-route');
  assert.equal(route.hidden, false);
  assert.match(route.textContent, /REPORTED VOYAGE/);
  assert.equal($('#cockpit-route-to').textContent, 'KIEL');
  assert.equal($('#cockpit-route-from'), null, 'AIS reports no origin');
  assert.equal($('#cockpit-route-direction').hidden, true);
});

test('entering the bridge names Live AIS Vessels as the ridden layer', async (t) => {
  const { cockpit } = fixture(t);
  const rides = [];
  cockpit.onRide = (layerId) => rides.push(layerId);
  assert.equal(cockpit.enter(), true);
  await settle();
  assert.deepEqual(rides, ['ais-live-vessels']);
});

test('exiting the bridge releases the vessel and returns to its map view', async (t) => {
  const { $, cockpit, vessels } = fixture(t);
  cockpit.enter();
  await settle();
  $('#map-view-switch').click();
  await settle();
  assert.equal(cockpit.active, false);
  assert.equal(cockpit.subjectKind, null);
  assert.deepEqual(vessels.calls, [
    ['subject', RECORD.mmsi],
    ['subject', null],
    ['focus'],
  ]);
  assert.match($('#map-view-switch').textContent, /EXIT COCKPIT/);
});

test('the bridge radar shows nearby ships without its own and steps its range', async (t) => {
  const { $, cockpit, vessels, store } = fixture(t);
  assert.equal(store.radar, null, 'no radar before the bridge');
  cockpit.enter();
  await settle();
  const radar = store.radar;
  assert.ok(radar, 'entering the bridge publishes a radar');
  assert.equal(radar.rangeNm, 3);
  assert.equal(radar.rangeLabel, '3 NM');
  assert.deepEqual(radar.ringsNm, [0.75, 1.5, 2.25, 3]);
  assert.deepEqual(
    radar.contacts.map((contact) => contact.id),
    [NEIGHBOUR.id],
    'the cockpit subject is not its own contact',
  );
  const [neighbour] = radar.contacts;
  assert.ok(Math.abs(neighbour.distanceNm - 2) < 0.02);
  // Heading 090: a ship to the north is on the port beam, heading west.
  assert.ok(neighbour.x < -0.3 && Math.abs(neighbour.y) < 0.02);
  assert.equal(neighbour.relativeCourseDeg, -180);
  assert.equal(radar.ownRelativeCourseDeg, 5, 'COG 095 from heading 090');
  assert.equal(vessels.radarQueries.at(-1).rangeM, 3 * 1852);

  assert.equal($('#cockpit-radar').hidden, false);
  assert.equal($('#cockpit-radar-range').textContent.trim(), '3 NM');
  assert.equal($('.cockpit-radar-count').textContent.trim(), '1 CONTACT');
  assert.equal(document.querySelectorAll('.cockpit-radar-contact').length, 1);

  $('#cockpit-radar-range').click();
  await settle();
  assert.equal(store.radar.rangeNm, 6);
  assert.equal(vessels.radarQueries.at(-1).rangeM, 6 * 1852);
  assert.equal($('#cockpit-radar-range').textContent.trim(), '6 NM');
  assert.match(
    $('#cockpit-radar-range').getAttribute('aria-label'),
    /Radar range 6 NM/,
  );

  cockpit.exit();
  await settle();
  assert.equal(store.radar, null, 'the radar ends with the bridge');
  assert.ok(!$('#cockpit-radar') || $('#cockpit-radar').hidden);
});

test('contact navigation does not jump ship from the bridge', async (t) => {
  const { cockpit, navigations } = fixture(t);
  cockpit.enter();
  await settle();
  assert.equal(cockpit.navigateContext(1, { origin: 'user' }), false);
  assert.equal(cockpit.navigateContext(-1, { origin: 'user' }), false);
  assert.deepEqual(navigations, []);
  assert.equal(cockpit.subjectKind, 'vessel');
});

test('tracking an aircraft from the bridge ends it without refocusing the vessel', async (t) => {
  const { cockpit, viewer, vessels, aircraft } = fixture(t);
  cockpit.enter();
  await settle();
  viewer.trackedEntity = aircraft;
  cockpit.update();
  assert.equal(cockpit.active, false);
  assert.equal(viewer.trackedEntity, aircraft, 'the aircraft keeps tracking');
  assert.equal(aircraft.show, true, 'the aircraft was never adopted');
  assert.deepEqual(vessels.calls, [
    ['subject', RECORD.mmsi],
    ['subject', null],
  ]);
});

test('a vessel that leaves the selection ends the bridge', async (t) => {
  const { cockpit, vessels } = fixture(t);
  cockpit.enter();
  await settle();
  vessels.deselect();
  cockpit.update();
  assert.equal(cockpit.active, false);
  assert.deepEqual(vessels.calls.at(-1), ['subject', null]);
});

test('turning off Live AIS Vessels ends the bridge', async (t) => {
  const { cockpit, vessels } = fixture(t);
  cockpit.enter();
  await settle();
  assert.equal(cockpit.active, true);
  vessels.disable();
  cockpit.update();
  assert.equal(cockpit.active, false);
  assert.deepEqual(vessels.calls.at(-1), ['subject', null]);
});

test("turning off the ridden aircraft's layer ends the cockpit", async (t) => {
  const aircraftInfo = {
    icao24: 'abc123',
    callsign: 'TEST1',
    latitude: 54.5,
    longitude: 10.2,
    altitudeM: 3000,
    velocityMps: 200,
    track: 45,
    onGround: false,
  };
  const { cockpit, viewer, aircraft, disableFlights } = fixture(t, {
    aircraftInfo,
  });
  viewer.trackedEntity = aircraft;
  assert.equal(cockpit.enter({ kind: 'aircraft' }), true);
  await settle();
  cockpit.update();
  assert.equal(cockpit.active, true);
  disableFlights();
  cockpit.update();
  assert.equal(cockpit.active, false);
});

test('BRIDGE enters the selected vessel bridge and aircraft-only entry refuses it', async (t) => {
  const { $, cockpit } = fixture(t);
  assert.equal(cockpit.enter({ kind: 'aircraft' }), false);
  cockpit.syncEntry();
  await settle();
  $('#cockpit-entry').click();
  await settle();
  assert.equal(cockpit.active, true);
  assert.equal(cockpit.subjectKind, 'vessel');
});

test('C neither enters nor leaves the bridge; it stays the CCTV shortcut', async (t) => {
  const { cockpit } = fixture(t);
  const outside = press(cockpit, 'c');
  await settle();
  assert.equal(cockpit.active, false, 'C does not enter');
  assert.equal(outside.defaultPrevented, false);
  assert.equal(outside.propagationStopped, false);
  cockpit.enter();
  await settle();
  assert.equal(cockpit.subjectKind, 'vessel');
  for (const key of ['c', 'C']) {
    const inside = press(cockpit, key);
    assert.equal(cockpit.active, true, `${key} does not exit`);
    assert.equal(inside.defaultPrevented, false);
    assert.equal(inside.propagationStopped, false);
  }
});

test('C stays the CCTV shortcut when the bridge gate is shut', async (t) => {
  const { cockpit } = fixture(t, { bridgeAllowed: false });
  let stopped = false;
  const event = {
    key: 'c',
    target: document.body,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      stopped = true;
    },
  };
  cockpit.onKeyDown(event);
  await settle();
  assert.equal(cockpit.active, false);
  assert.equal(event.defaultPrevented, false);
  assert.equal(stopped, false, 'the application shortcut still sees C');
});

test('a slow-frame bridge keeps pace with its ship', async (t) => {
  // One rendered frame a second, as software rendering manages. The bridge
  // must still cover the ship's distance, not a capped fraction of it.
  const startMs = 1_800_000_000_000;
  const clock = manualClock(t, startMs);
  const record = { ...RECORD, lastPositionEpoch: startMs / 1000 };
  const { cockpit, views } = fixture(t, { record });
  cockpit.enter();
  await settle();
  for (let frame = 0; frame <= 20; frame += 1) {
    cockpit.update();
    clock.advance(1000);
  }
  assert.ok(
    views.length >= 20,
    `expected a view per frame, got ${views.length}`,
  );
  const travelledM = Cesium.Cartesian3.distance(views[0], views.at(-1));
  const expectedM = (views.length - 1) * RECORD.speed * 0.514444;
  assert.ok(
    Math.abs(travelledM - expectedM) < expectedM * 0.05,
    `travelled ${travelledM.toFixed(1)} m, expected ~${expectedM.toFixed(1)} m`,
  );
});

/** Press a key through the Cockpit's keydown handler. */
function press(
  cockpit,
  key,
  { shiftKey = false, repeat = false, target = document.body } = {},
) {
  const event = {
    key,
    shiftKey,
    repeat,
    target,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      this.propagationStopped = true;
    },
  };
  cockpit.onKeyDown(event);
  return event;
}

/** A placed camera's view heading and pitch in its local east-north-up frame. */
function viewAngles({ destination, direction }) {
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(destination);
  const toLocal = Cesium.Matrix4.inverseTransformation(
    enu,
    new Cesium.Matrix4(),
  );
  const local = Cesium.Matrix4.multiplyByPointAsVector(
    toLocal,
    direction,
    new Cesium.Cartesian3(),
  );
  const headingDeg =
    ((Cesium.Math.toDegrees(Math.atan2(local.x, local.y)) % 360) + 360) % 360;
  const pitchDeg = Cesium.Math.toDegrees(
    Math.asin(Math.max(-1, Math.min(1, local.z))),
  );
  return { headingDeg, pitchDeg };
}

/** Run `count` camera updates 50 ms apart; returns the last view. */
function frames(cockpit, clock, shots, count = 20) {
  for (let frame = 0; frame < count; frame += 1) {
    clock.advance(50);
    cockpit.update();
  }
  return viewAngles(shots.at(-1));
}

const near = (actual, expected, label, tolerance = 0.2) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual.toFixed(3)} not within ${tolerance} of ${expected}`,
  );

const START_MS = 1_800_000_000_000;

async function bridgeAt(t, clock) {
  clock.set(START_MS);
  const record = { ...RECORD, lastPositionEpoch: START_MS / 1000 };
  const scene = fixture(t, { record });
  scene.cockpit.enter();
  await settle();
  scene.cockpit.update();
  return scene;
}

test('arrows turn the bridge view without moving the eye off its path', async (t) => {
  const clock = manualClock(t, START_MS);
  // A bridge left alone, for the eye's path.
  const still = await bridgeAt(t, clock);
  frames(still.cockpit, clock, still.shots, 30);
  const stillPath = still.shots.map((shot) => shot.destination);
  still.cockpit.stop();

  const { cockpit, shots, store, $ } = await bridgeAt(t, clock);
  let view = viewAngles(shots.at(-1));
  near(view.headingDeg, RECORD.heading, 'starts over the bow');
  near(view.pitchDeg, -2, 'at the rest pitch');
  assert.equal(store.instruments.look.offset, false);

  const event = press(cockpit, 'ArrowRight', { shiftKey: true });
  assert.equal(event.defaultPrevented, true);
  press(cockpit, 'ArrowRight', { shiftKey: true });
  // Partway through the ease the view is between the bow and the beam.
  clock.advance(50);
  cockpit.update();
  const midway = viewAngles(shots.at(-1)).headingDeg;
  assert.ok(midway > 100 && midway < 175, `midway heading ${midway}`);
  view = frames(cockpit, clock, shots, 9);
  near(view.headingDeg, RECORD.heading + 90, 'starboard beam');
  press(cockpit, 'ArrowUp');
  press(cockpit, 'ArrowUp');
  press(cockpit, 'ArrowUp');
  view = frames(cockpit, clock, shots, 20);
  near(view.pitchDeg, 10, 'pitched up');
  assert.deepEqual(cockpit.lookTarget, { yawDeg: 90, pitchDeg: 10 });

  // The eye followed exactly the path of the bridge left alone.
  assert.equal(shots.length, stillPath.length);
  shots.forEach((shot, index) =>
    assert.ok(
      Cesium.Cartesian3.distance(shot.destination, stillPath[index]) < 1e-6,
      `frame ${index} moved the eye`,
    ),
  );

  await settle();
  assert.equal(store.instruments.look.offset, true);
  assert.equal(store.instruments.look.yawDeg, 90);
  assert.equal($('.cockpit-look').hidden, false);
  assert.equal(
    $('#cockpit-look-readout').textContent,
    'LOOK STBD 090° · UP 10°',
  );
  assert.ok(
    $('.cockpit-radar-look'),
    'the radar draws the look line while the view is turned',
  );
  assert.match($('.cockpit-help').textContent, /ARROWS LOOK · HOME RESET/);
  // The heading readout keeps the ship's heading.
  assert.equal(store.instruments.heading.text, '090');
});

test('the bridge view pitches no further than straight up or down', async (t) => {
  const clock = manualClock(t, START_MS);
  const { cockpit, shots, store } = await bridgeAt(t, clock);
  for (let index = 0; index < 4; index += 1)
    press(cockpit, 'ArrowUp', { shiftKey: true });
  assert.equal(cockpit.lookTarget.pitchDeg, 90);
  let view = frames(cockpit, clock, shots);
  near(view.pitchDeg, 90, 'straight up', 0.5);
  const up = viewAngles({
    destination: shots.at(-1).destination,
    direction: shots.at(-1).up,
  });
  near(up.headingDeg, (RECORD.heading + 180) % 360, 'up stays valid', 1);

  for (let index = 0; index < 5; index += 1)
    press(cockpit, 'ArrowDown', { shiftKey: true });
  assert.equal(cockpit.lookTarget.pitchDeg, -90);
  view = frames(cockpit, clock, shots);
  near(view.pitchDeg, -90, 'straight down', 0.5);
  await settle();
  assert.equal(store.instruments.look.readout, 'LOOK DOWN 90°');
});

test('the heading tape follows the bridge look; bow and stern marks stay on the ship', async (t) => {
  const clock = manualClock(t, START_MS);
  const { cockpit, shots, store, $ } = await bridgeAt(t, clock);
  const tape = async () => {
    frames(cockpit, clock, shots, 40);
    await settle();
    const { compass, compassMarkers, heading } = store.instruments;
    return {
      centre: compass.find((division) => division.active).label,
      heading: heading.value,
      ...compassMarkers,
    };
  };
  // Over the bow: the tape centres on the ship's heading, east.
  let reading = await tape();
  assert.equal(reading.centre, 'E');
  assert.equal(reading.prograde, 0);
  assert.equal(reading.retrograde, null, 'the stern is off the tape');
  assert.equal($('.cockpit-compass-retrograde'), null);
  const bow = $('.cockpit-compass-prograde');
  assert.equal(bow.getAttribute('aria-hidden'), 'true');
  assert.equal(bow.style.getPropertyValue('--slot'), '0');
  // Turned to port onto north: the tape follows the camera, the HDG readout
  // keeps the ship's heading and both marks sit at their relative bearings.
  press(cockpit, 'ArrowLeft', { shiftKey: true });
  press(cockpit, 'ArrowLeft', { shiftKey: true });
  reading = await tape();
  assert.equal(reading.centre, 'N');
  near(reading.heading, RECORD.heading, 'the HDG readout', 1e-6);
  near(reading.prograde, 3, 'the bow, 90° to starboard', 1e-6);
  near(reading.retrograde, -3, 'the stern, 90° to port', 1e-6);
  assert.equal(
    $('.cockpit-compass-retrograde').getAttribute('aria-hidden'),
    'true',
  );
  // Further round, onto 315°: the bow leaves the tape, the stern comes
  // under W, 45° to port.
  press(cockpit, 'ArrowLeft', { shiftKey: true });
  reading = await tape();
  assert.equal(reading.prograde, null);
  near(reading.retrograde, -1.5, 'the stern, under W', 1e-6);
  const west = store.instruments.compass.find(({ label }) => label === 'W');
  near(west.slot, reading.retrograde, 'W over the stern mark', 1e-6);
  assert.equal($('.cockpit-compass-prograde'), null);
  assert.equal(
    $('.cockpit-compass-retrograde').style.getPropertyValue('--slot'),
    String(reading.retrograde),
  );
});

test('a held arrow keeps turning the bridge view', async (t) => {
  const clock = manualClock(t, START_MS);
  const { cockpit } = await bridgeAt(t, clock);
  press(cockpit, 'ArrowLeft');
  for (let index = 0; index < 5; index += 1) {
    const event = press(cockpit, 'ArrowLeft', { repeat: true });
    assert.equal(event.defaultPrevented, true);
  }
  assert.equal(cockpit.lookTarget.yawDeg, -30);
  // A held Home still acts only once.
  press(cockpit, 'Home', { repeat: true });
  assert.equal(cockpit.lookTarget.yawDeg, -30);
});

test('Home, 0 and LOOK AHEAD bring the bridge view back over the bow', async (t) => {
  const clock = manualClock(t, START_MS);
  const { cockpit, shots, store, $ } = await bridgeAt(t, clock);
  const turnAway = () => {
    press(cockpit, 'ArrowLeft', { shiftKey: true });
    press(cockpit, 'ArrowDown');
    frames(cockpit, clock, shots);
  };
  const resets = [
    () => press(cockpit, 'Home'),
    () => press(cockpit, '0'),
    () => $('#cockpit-look-ahead').click(),
  ];
  for (const reset of resets) {
    turnAway();
    await settle();
    assert.equal($('.cockpit-look').hidden, false);
    assert.equal(
      $('#cockpit-look-ahead').getAttribute('aria-label'),
      'Look ahead: turn the bridge view back to the bow',
    );
    reset();
    assert.deepEqual(cockpit.lookTarget, { yawDeg: 0, pitchDeg: -2 });
    // It eases back rather than snapping.
    clock.advance(50);
    cockpit.update();
    const easing = viewAngles(shots.at(-1)).headingDeg;
    assert.ok(easing > 46 && easing < 89, `easing heading ${easing}`);
    const view = frames(cockpit, clock, shots);
    near(view.headingDeg, RECORD.heading, 'back over the bow');
    near(view.pitchDeg, -2, 'back at the rest pitch');
    await settle();
    assert.equal(store.instruments.look.offset, false);
    assert.equal($('.cockpit-look').hidden, true);
    assert.equal($('.cockpit-radar-look'), null);
  }
});

test('arrows keep their meaning in sliders, fields and open utilities', async (t) => {
  const clock = manualClock(t, START_MS);
  const { cockpit } = await bridgeAt(t, clock);
  const slider = document.body.appendChild(document.createElement('div'));
  slider.setAttribute('role', 'slider');
  const thumb = slider.appendChild(document.createElement('span'));
  const field = document.body.appendChild(document.createElement('input'));
  for (const target of [slider, thumb, field]) {
    for (const key of ['ArrowLeft', 'ArrowUp', 'Home', '0']) {
      const event = press(cockpit, key, { target });
      assert.equal(
        event.defaultPrevented,
        false,
        `${key} in ${target.tagName}`,
      );
    }
  }
  cockpit.isUtilityDisclosureOpen = () => true;
  assert.equal(press(cockpit, 'ArrowRight').defaultPrevented, false);
  assert.deepEqual(cockpit.lookTarget, { yawDeg: 0, pitchDeg: -2 });

  // A plain HUD button, where focus sits after entry, still turns the view.
  cockpit.isUtilityDisclosureOpen = () => false;
  const exit = document.getElementById('map-view-switch');
  const event = press(cockpit, 'ArrowRight', { target: exit });
  assert.equal(event.defaultPrevented, true);
  assert.equal(cockpit.lookTarget.yawDeg, 5);
});

test('the bridge view opens over the bow on every entry', async (t) => {
  const clock = manualClock(t, START_MS);
  const { cockpit, shots, store } = await bridgeAt(t, clock);
  press(cockpit, 'ArrowRight', { shiftKey: true });
  press(cockpit, 'ArrowUp');
  frames(cockpit, clock, shots, 5);
  cockpit.exit();
  assert.deepEqual(cockpit.lookTarget, { yawDeg: 0, pitchDeg: -2 });
  assert.deepEqual(cockpit.lookView, { yawDeg: 0, pitchDeg: -2 });
  assert.equal(store.instruments.look.offset, false);
  assert.equal(press(cockpit, 'ArrowRight').defaultPrevented, false);

  cockpit.enter();
  await settle();
  clock.advance(50);
  cockpit.update();
  const view = viewAngles(shots.at(-1));
  near(view.headingDeg, RECORD.heading, 're-entry looks over the bow');
  near(view.pitchDeg, -2, 're-entry at the rest pitch');
});

test('arrows do nothing new in an aircraft cockpit', async (t) => {
  const clock = manualClock(t, START_MS);
  const aircraftInfo = {
    icao24: 'abc123',
    callsign: 'TEST1',
    latitude: 54.5,
    longitude: 10.2,
    altitudeM: 3000,
    velocityMps: 200,
    track: 45,
    onGround: false,
  };
  const { cockpit, viewer, aircraft, shots, store } = fixture(t, {
    aircraftInfo,
  });
  viewer.trackedEntity = aircraft;
  assert.equal(cockpit.enter({ kind: 'aircraft' }), true);
  await settle();
  assert.equal(cockpit.subjectKind, 'aircraft');
  const before = frames(cockpit, clock, shots, 3);
  near(before.headingDeg, 45, 'the aircraft looks along its track');
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', '0'];
  for (const key of keys) {
    for (const shiftKey of [false, true]) {
      const event = press(cockpit, key, { shiftKey });
      assert.equal(event.defaultPrevented, false, `${key} in an aircraft`);
    }
  }
  const held = press(cockpit, 'ArrowLeft', { repeat: true });
  assert.equal(held.defaultPrevented, false);
  const after = frames(cockpit, clock, shots, 3);
  // The aircraft flies on, so its local frame shifts by a hair.
  near(after.headingDeg, before.headingDeg, 'the aircraft heading', 1e-6);
  near(after.pitchDeg, before.pitchDeg, 'the aircraft pitch', 1e-6);
  assert.deepEqual(cockpit.lookTarget, { yawDeg: 0, pitchDeg: -2 });
  assert.equal(store.instruments.look.offset, false);
  assert.equal(document.querySelector('.cockpit-look'), null);
  // The tape stays on the aircraft's heading, with no bow or stern marks.
  const centre = store.instruments.compass.find(
    (division) => division.slot === 0,
  );
  assert.equal(centre.label, '060');
  assert.deepEqual(store.instruments.compassMarkers, {
    prograde: null,
    retrograde: null,
  });
  assert.equal(document.querySelector('.cockpit-compass-marker'), null);
  assert.doesNotMatch(
    document.querySelector('.cockpit-help').textContent,
    /ARROWS LOOK/,
  );
});

test('C neither enters nor leaves an aircraft cockpit', async (t) => {
  const aircraftInfo = {
    icao24: 'abc123',
    callsign: 'TEST1',
    latitude: 54.5,
    longitude: 10.2,
    altitudeM: 3000,
    velocityMps: 200,
    track: 45,
    onGround: false,
  };
  const { cockpit, viewer, aircraft } = fixture(t, { aircraftInfo });
  viewer.trackedEntity = aircraft;
  const outside = press(cockpit, 'c');
  await settle();
  assert.equal(cockpit.active, false, 'C does not enter');
  assert.equal(outside.defaultPrevented, false);
  assert.equal(outside.propagationStopped, false);
  assert.equal(cockpit.enter({ kind: 'aircraft' }), true);
  await settle();
  const inside = press(cockpit, 'c');
  assert.equal(cockpit.active, true, 'C does not exit');
  assert.equal(inside.propagationStopped, false);
  assert.doesNotMatch(
    document.querySelector('.cockpit-help').textContent,
    /C TOGGLE/,
  );
  assert.doesNotMatch(
    document
      .querySelector('#map-view-switch')
      .getAttribute('aria-keyshortcuts'),
    /C/,
  );
});

/** The eye's ellipsoidal height in a placed camera, metres. */
const eyeHeightM = (shot) =>
  Cesium.Cartographic.fromCartesian(shot.destination).height;

test('a bridge on a river above sea level rides the water, not the geoid', async (t) => {
  const clock = manualClock(t, START_MS);
  // Sea level, as every ship is floated today.
  const sea = await bridgeAt(t, clock);
  frames(sea.cockpit, clock, sea.shots, 60);
  const seaEyeM = eyeHeightM(sea.shots.at(-1));
  sea.cockpit.exit();

  clock.set(START_MS);
  const record = { ...RECORD, lastPositionEpoch: START_MS / 1000 };
  const river = fixture(t, { record });
  const probed = [];
  // The ship's own model reads 40 m; the ring finds the river at 27 m and
  // a quay at 33 m.
  river.viewer.scene.sampleHeightMostDetailed = async (positions) => {
    probed.push(positions.length);
    return positions.map((position, index) =>
      Object.assign(position, {
        height: index === 0 ? 40 : index % 2 ? 27 : 33,
      }),
    );
  };
  river.cockpit.enter();
  await settle();
  river.cockpit.update();
  await settle();
  frames(river.cockpit, clock, river.shots, 60);
  near(
    eyeHeightM(river.shots.at(-1)) - seaEyeM,
    27,
    'raised by the river',
    0.5,
  );
  assert.equal(probed[0], 9, 'the ship and eight probes around it');
  const reads = probed.length;
  frames(river.cockpit, clock, river.shots, 20);
  await settle();
  assert.equal(probed.length, reads, 'no new read inside five seconds');
  frames(river.cockpit, clock, river.shots, 80);
  await settle();
  assert.ok(probed.length > reads, 'a fresh read every five seconds');
});

test('a bridge at sea keeps the geoid when the probes find no raised water', async (t) => {
  const clock = manualClock(t, START_MS);
  const sea = await bridgeAt(t, clock);
  frames(sea.cockpit, clock, sea.shots, 60);
  const seaEyeM = eyeHeightM(sea.shots.at(-1));
  sea.cockpit.exit();

  clock.set(START_MS);
  const record = { ...RECORD, lastPositionEpoch: START_MS / 1000 };
  const open = fixture(t, { record });
  // Swell and tiles a metre off the geoid, and a probe that found nothing.
  open.viewer.scene.sampleHeightMostDetailed = async (positions) =>
    positions.map((position, index) =>
      Object.assign(position, { height: index === 3 ? undefined : 1 }),
    );
  open.cockpit.enter();
  await settle();
  open.cockpit.update();
  await settle();
  frames(open.cockpit, clock, open.shots, 60);
  near(eyeHeightM(open.shots.at(-1)), seaEyeM, 'still on the geoid', 0.5);
});

test('a bridge rides the river at once from the tiles already loaded', async (t) => {
  const clock = manualClock(t, START_MS);
  const sea = await bridgeAt(t, clock);
  frames(sea.cockpit, clock, sea.shots, 60);
  const seaEyeM = eyeHeightM(sea.shots.at(-1));
  sea.cockpit.exit();

  clock.set(START_MS);
  const record = { ...RECORD, lastPositionEpoch: START_MS / 1000 };
  const river = fixture(t, { record });
  // The full-detail read is still loading tiles; the loaded ones already
  // show the river at 27 m beside a quay at 33 m.
  river.viewer.scene.sampleHeightMostDetailed = () => new Promise(() => {});
  let index = 0;
  river.viewer.scene.sampleHeight = () => (index++ % 2 ? 27 : 33);
  river.cockpit.enter();
  await settle();
  river.cockpit.update();
  frames(river.cockpit, clock, river.shots, 60);
  near(
    eyeHeightM(river.shots.at(-1)) - seaEyeM,
    27,
    'on the river before the detailed read',
    0.5,
  );
});

/**
 * A scene that draws a world point at (400, 300 − its height in metres): a
 * mark's height above the ellipsoid moves it on screen.
 */
function heightSensitiveProjection(viewer, { x = 400 } = {}) {
  viewer.scene.cartesianToCanvasCoordinates = (position, result) => {
    const { height } = Cesium.Cartographic.fromCartesian(position);
    return Object.assign(result, { x, y: 300 - height });
  };
}

test('a vessel double-click aims at the sprite as drawn, on the geoid', async (t) => {
  const { cockpit, viewer, store } = fixture(t);
  // The Baltic geoid sits ~35 m above the ellipsoid; the sprite 3 m above it.
  const subject = cockpit.services.aisLiveVesselsLayer.getCockpitSubject;
  cockpit.services.aisLiveVesselsLayer.getCockpitSubject = () => ({
    ...subject(),
    seaSurfaceHeightM: 35,
    markHeightM: 38,
  });
  heightSensitiveProjection(viewer);
  // Where an ellipsoid-height projection would put it: no hit.
  assert.equal(cockpit.onSceneDoubleClick({ x: 400, y: 300 }), false);
  assert.equal(cockpit.onSceneDoubleClick({ x: 400, y: 262 }), true);
  await settle();
  assert.equal(store.presence.active, true);
});

test('a vessel double-click lands even when the first click moved the ship', async (t) => {
  const { cockpit, viewer, store } = fixture(t);
  heightSensitiveProjection(viewer);
  // The first press finds the ship at (400, 300); selecting it again
  // re-centres the camera, so by the double-click it is drawn at (600, 300).
  cockpit.onScenePointerDown(1000);
  heightSensitiveProjection(viewer, { x: 600 });
  // Too late to count as one gesture.
  assert.equal(cockpit.onSceneDoubleClick({ x: 400, y: 300 }, 1800), false);
  cockpit.onScenePointerDown(2000);
  heightSensitiveProjection(viewer, { x: 800 });
  assert.equal(cockpit.onSceneDoubleClick({ x: 600, y: 300 }, 2300), true);
  await settle();
  assert.equal(store.presence.active, true);
});

test('re-entering a ship reads its water afresh, never the last session height', async (t) => {
  const clock = manualClock(t, START_MS);
  const sea = await bridgeAt(t, clock);
  frames(sea.cockpit, clock, sea.shots, 60);
  const seaEyeM = eyeHeightM(sea.shots.at(-1));
  sea.cockpit.exit();

  clock.set(START_MS);
  const record = { ...RECORD, lastPositionEpoch: START_MS / 1000 };
  const ship = fixture(t, { record });
  const scene = ship.viewer.scene;
  // First visit: on a river 27 m up.
  scene.sampleHeightMostDetailed = async (positions) =>
    positions.map((position) => Object.assign(position, { height: 27 }));
  ship.cockpit.enter();
  await settle();
  ship.cockpit.update();
  await settle();
  frames(ship.cockpit, clock, ship.shots, 60);
  near(eyeHeightM(ship.shots.at(-1)) - seaEyeM, 27, 'on the river', 0.5);
  ship.cockpit.exit();
  await settle();
  // Back on the same ship, now at sea; the detailed read is slow, the
  // loaded tiles already show the sea.
  let late;
  scene.sampleHeightMostDetailed = () =>
    new Promise((resolve) => {
      late = resolve;
    });
  scene.sampleHeight = () => 0.5;
  ship.cockpit.enter();
  await settle();
  ship.cockpit.update();
  frames(ship.cockpit, clock, ship.shots, 60);
  near(eyeHeightM(ship.shots.at(-1)), seaEyeM, 'at sea, not on the river', 0.5);
  // A read from before the exit, landing now, changes nothing.
  ship.cockpit.exit();
  ship.cockpit.enter();
  await settle();
  late?.([{ height: 27 }]);
  await settle();
  ship.cockpit.update();
  frames(ship.cockpit, clock, ship.shots, 60);
  near(eyeHeightM(ship.shots.at(-1)), seaEyeM, 'the late read is dropped', 0.5);
});

test('a failed water read keeps the sea and tries again', async (t) => {
  const clock = manualClock(t, START_MS);
  const sea = await bridgeAt(t, clock);
  frames(sea.cockpit, clock, sea.shots, 60);
  const seaEyeM = eyeHeightM(sea.shots.at(-1));
  sea.cockpit.exit();

  clock.set(START_MS);
  const record = { ...RECORD, lastPositionEpoch: START_MS / 1000 };
  const ship = fixture(t, { record });
  let reads = 0;
  ship.viewer.scene.sampleHeightMostDetailed = async () => {
    reads += 1;
    throw new Error('tiles unavailable');
  };
  ship.cockpit.enter();
  await settle();
  ship.cockpit.update();
  await settle();
  frames(ship.cockpit, clock, ship.shots, 60);
  near(eyeHeightM(ship.shots.at(-1)), seaEyeM, 'still on the sea', 0.5);
  frames(ship.cockpit, clock, ship.shots, 120);
  await settle();
  assert.ok(reads >= 2, `retried: ${reads} reads`);
});

test('the water is read where the ship is now, not at its last report', async (t) => {
  const clock = manualClock(t, START_MS);
  // Reported a minute ago at 12 kn on course 095: since then ~370 m east.
  const record = { ...RECORD, lastPositionEpoch: (START_MS - 60_000) / 1000 };
  const ship = fixture(t, { record });
  const centres = [];
  ship.viewer.scene.sampleHeightMostDetailed = async (positions) => {
    centres.push(Cesium.Math.toDegrees(positions[0].longitude));
    return positions;
  };
  ship.cockpit.enter();
  await settle();
  ship.cockpit.update();
  await settle();
  assert.ok(centres.length > 0, 'a read was made');
  const eastM =
    (centres[0] - RECORD.lon) *
    111_320 *
    Math.cos((RECORD.lat * Math.PI) / 180);
  assert.ok(eastM > 300 && eastM < 450, `probed ${eastM.toFixed(0)} m east`);
});

test('the bridge floor is read where the ship is now, not at its last report', async (t) => {
  const clock = manualClock(t, START_MS);
  // Reported a minute ago at 12 kn on course 095: since then ~370 m east.
  const record = { ...RECORD, lastPositionEpoch: (START_MS - 60_000) / 1000 };
  const ship = fixture(t, { record });
  const floors = [];
  const cached = ship.cockpit.services.cachedGroundFloor;
  ship.cockpit.services.cachedGroundFloor = (lat, lon) => {
    floors.push({ lat, lon });
    return cached(lat, lon);
  };
  ship.cockpit.enter();
  await settle();
  frames(ship.cockpit, clock, ship.shots, 20);
  const first = floors[0];
  assert.ok(first, 'the floor was read');
  const eastM =
    (first.lon - RECORD.lon) * 111_320 * Math.cos((RECORD.lat * Math.PI) / 180);
  assert.ok(eastM > 300 && eastM < 450, `read ${eastM.toFixed(0)} m east`);
});

test('the radar centres where the camera rides, not at the last report', async (t) => {
  const clock = manualClock(t, START_MS);
  // Reported a minute ago at 12 kn on course 095: since then ~370 m east.
  const record = { ...RECORD, lastPositionEpoch: (START_MS - 60_000) / 1000 };
  const ship = fixture(t, { record });
  ship.cockpit.enter();
  await settle();
  frames(ship.cockpit, clock, ship.shots, 20);
  await settle();
  const query = ship.vessels.radarQueries.at(-1);
  const eastM =
    (query.lon - RECORD.lon) * 111_320 * Math.cos((RECORD.lat * Math.PI) / 180);
  assert.ok(eastM > 300 && eastM < 450, `centred ${eastM.toFixed(0)} m east`);
});

test('the radar look line turns the short way across astern', async (t) => {
  const clock = manualClock(t, START_MS);
  const { $, store } = await bridgeAt(t, clock);
  const lookAt = async (yawDeg) => {
    store.publishInstruments({
      ...store.instruments,
      look: { ...store.instruments.look, offset: true, yawDeg },
    });
    await settle();
    return $('.cockpit-radar-look')?.getAttribute('style') ?? '';
  };
  assert.match(await lookAt(170), /rotate\(170deg\)/);
  // From 170° to -170° is 20° through astern, not 340° back over the bow.
  assert.match(await lookAt(-170), /rotate\(190deg\)/);
});

test('a ship with no true heading is held, and labelled, on its course', async (t) => {
  const clock = manualClock(t, START_MS);
  clock.set(START_MS);
  const record = {
    ...RECORD,
    heading: null,
    lastPositionEpoch: START_MS / 1000,
  };
  const { $, cockpit } = fixture(t, { record });
  const signals = [];
  cockpit.pushCockpitSignal = (...args) => signals.push(args);
  cockpit.enter();
  await settle();
  cockpit.update();
  await settle();
  assert.match(
    $('.cockpit-visor-status-right').textContent,
    /COURSE HOLD · AIS/,
  );
  assert.ok(
    signals.some(([, , , detail]) => /COURSE 095°/.test(detail)),
    JSON.stringify(signals),
  );
});

test('both entries name the subject the same way', async () => {
  const { cockpitEntryFace } = await import('./cockpitPresentation.js');
  assert.deepEqual(cockpitEntryFace('vessel'), {
    icon: 'directions_boat',
    label: 'BRIDGE',
  });
  assert.deepEqual(cockpitEntryFace('satellite'), {
    icon: 'satellite_alt',
    label: 'ORBIT',
  });
  assert.deepEqual(cockpitEntryFace('aircraft'), {
    icon: 'flight',
    label: 'COCKPIT',
  });
  assert.deepEqual(cockpitEntryFace(null), cockpitEntryFace('aircraft'));
});

test('a ship with neither heading nor course makes up no direction', async (t) => {
  const clock = manualClock(t, START_MS);
  const record = {
    ...RECORD,
    heading: null,
    course: null,
    lastPositionEpoch: START_MS / 1000,
  };
  const { $, cockpit, viewer, shots, store } = fixture(t, { record });
  // The map camera looks south-south-west as the bridge opens.
  viewer.camera.heading = Cesium.Math.toRadians(200);
  const signals = [];
  cockpit.pushCockpitSignal = (...args) => signals.push(args);
  cockpit.enter();
  await settle();
  cockpit.update();
  const start = shots.at(-1).destination;
  // Ten seconds at 12 kn would carry a made-up course some 60 m.
  const view = frames(cockpit, clock, shots, 200);
  await settle();
  near(view.headingDeg, 200, 'keeps the entry camera heading');
  const driftM = Cesium.Cartesian3.distance(start, shots.at(-1).destination);
  assert.ok(driftM < 1, `the eye stays on the fix, drifted ${driftM} m`);
  assert.equal(store.instruments.heading.text, '---');
  assert.deepEqual(store.instruments.compassMarkers, {
    prograde: null,
    retrograde: null,
  });
  assert.equal(document.querySelector('.cockpit-compass-marker'), null);
  assert.match(
    $('.cockpit-visor-status-right').textContent,
    /NO HEADING · AIS/,
  );
  const details = signals.map(([, , , detail]) => detail);
  assert.ok(details.includes('NORDIC STAR · NO HEADING'), details.join(' | '));
  assert.ok(!details.some((detail) => /000°/.test(detail)), details.join());
});

test('the bridge tape reads the exact heading at the caret', async (t) => {
  const clock = manualClock(t, START_MS);
  const record = {
    ...RECORD,
    heading: 100,
    lastPositionEpoch: START_MS / 1000,
  };
  const { cockpit, shots, store } = fixture(t, { record });
  cockpit.enter();
  await settle();
  frames(cockpit, clock, shots, 40);
  await settle();
  const { compass, compassMarkers } = store.instruments;
  // Over the bow at 100°: the bow mark sits under the caret, and the tape
  // has scrolled a third of a division past 090.
  near(compassMarkers.prograde, 0, 'the bow under the caret', 1e-3);
  const nearest = compass.find((division) => division.active);
  assert.equal(nearest.label, 'E');
  near(nearest.slot, -1 / 3, 'E a third of a division to port', 1e-3);
  const tape = document.querySelector('#cockpit-compass-tape');
  near(
    Number(tape.style.getPropertyValue('--tape-shift')),
    -1 / 3,
    'the minor ticks scroll with it',
    1e-3,
  );
  const east = [...tape.querySelectorAll('span')].find(
    (span) => span.textContent === 'E',
  );
  assert.equal(east.className, 'active');
  near(Number(east.style.getPropertyValue('--slot')), -1 / 3, 'E drawn', 1e-3);
});

test('a slow water read is never stacked, and lands however late', async (t) => {
  const clock = manualClock(t, START_MS);
  const sea = await bridgeAt(t, clock);
  frames(sea.cockpit, clock, sea.shots, 60);
  const seaEyeM = eyeHeightM(sea.shots.at(-1));
  sea.cockpit.exit();

  clock.set(START_MS);
  const record = { ...RECORD, lastPositionEpoch: START_MS / 1000 };
  const ship = fixture(t, { record });
  const reads = [];
  // Every full-detail read hangs until the test answers it.
  ship.viewer.scene.sampleHeightMostDetailed = (positions) =>
    new Promise((resolve) => reads.push({ positions, resolve }));
  let loadedReads = 0;
  ship.viewer.scene.sampleHeight = () => {
    loadedReads += 1;
    return 0;
  };
  ship.cockpit.enter();
  await settle();
  ship.cockpit.update();
  await settle();
  assert.equal(reads.length, 1);
  const loadedAtStart = loadedReads;
  // Twelve seconds on, still one read in flight; the refreshes read the
  // loaded tiles meanwhile.
  frames(ship.cockpit, clock, ship.shots, 240);
  await settle();
  assert.equal(reads.length, 1, 'no second read while the first runs');
  assert.ok(loadedReads > loadedAtStart, 'the loaded tiles are read again');
  // The 12 s read lands (a river at 27 m) and applies.
  const [slow] = reads;
  slow.resolve(
    slow.positions.map((position) => Object.assign(position, { height: 27 })),
  );
  await settle();
  frames(ship.cockpit, clock, ship.shots, 120);
  await settle();
  near(
    eyeHeightM(ship.shots.at(-1)) - seaEyeM,
    27,
    'raised by the late read',
    0.5,
  );
  // Settled, the next refresh starts a new read.
  assert.equal(reads.length, 2);
  // It hangs over tiles not loaded yet: the refreshes sample nothing, and the
  // river height stands rather than falling back to the sea.
  ship.viewer.scene.sampleHeight = () => undefined;
  frames(ship.cockpit, clock, ship.shots, 240);
  await settle();
  assert.equal(reads.length, 2);
  near(
    eyeHeightM(ship.shots.at(-1)) - seaEyeM,
    27,
    'kept through refreshes that sample nothing',
    0.5,
  );
});

test('a river height stands through reads that sample nothing or one coarse probe', async (t) => {
  const clock = manualClock(t, START_MS);
  const sea = await bridgeAt(t, clock);
  frames(sea.cockpit, clock, sea.shots, 60);
  const seaEyeM = eyeHeightM(sea.shots.at(-1));
  sea.cockpit.exit();

  clock.set(START_MS);
  const record = { ...RECORD, lastPositionEpoch: START_MS / 1000 };
  const ship = fixture(t, { record });
  const reads = [];
  ship.viewer.scene.sampleHeightMostDetailed = (positions) =>
    new Promise((resolve) => reads.push({ positions, resolve }));
  ship.viewer.scene.sampleHeight = () => undefined;
  const answer = (read, height) =>
    read.resolve(
      read.positions.map((position) => Object.assign(position, { height })),
    );
  ship.cockpit.enter();
  await settle();
  ship.cockpit.update();
  await settle();
  answer(reads[0], 27);
  await settle();
  frames(ship.cockpit, clock, ship.shots, 120);
  await settle();
  near(eyeHeightM(ship.shots.at(-1)) - seaEyeM, 27, 'on the river', 0.5);
  // The next full read lands over tiles not loaded yet: every probe empty.
  assert.equal(reads.length, 2);
  answer(reads[1], undefined);
  await settle();
  frames(ship.cockpit, clock, ship.shots, 120);
  await settle();
  near(
    eyeHeightM(ship.shots.at(-1)) - seaEyeM,
    27,
    'an empty full read is no answer',
    0.5,
  );
  // While the next one runs, coarse loaded tiles read the sea.
  assert.equal(reads.length, 3);
  ship.viewer.scene.sampleHeight = () => 0.5;
  frames(ship.cockpit, clock, ship.shots, 240);
  await settle();
  assert.equal(reads.length, 3, 'still the one read in flight');
  near(
    eyeHeightM(ship.shots.at(-1)) - seaEyeM,
    27,
    'loaded tiles do not undo a full read',
    0.5,
  );
});

test('before any full read lands, a coarse loaded read keeps the river it found', async (t) => {
  const clock = manualClock(t, START_MS);
  const sea = await bridgeAt(t, clock);
  frames(sea.cockpit, clock, sea.shots, 60);
  const seaEyeM = eyeHeightM(sea.shots.at(-1));
  sea.cockpit.exit();

  clock.set(START_MS);
  const record = { ...RECORD, lastPositionEpoch: START_MS / 1000 };
  const ship = fixture(t, { record });
  // The full-detail read is cold and never lands in this test.
  ship.viewer.scene.sampleHeightMostDetailed = () => new Promise(() => {});
  ship.viewer.scene.sampleHeight = () => 27;
  ship.cockpit.enter();
  await settle();
  ship.cockpit.update();
  frames(ship.cockpit, clock, ship.shots, 60);
  near(eyeHeightM(ship.shots.at(-1)) - seaEyeM, 27, 'on the river', 0.5);
  // A refresh meets one low probe on coarse tiles.
  ship.viewer.scene.sampleHeight = () => 0.5;
  frames(ship.cockpit, clock, ship.shots, 240);
  near(eyeHeightM(ship.shots.at(-1)) - seaEyeM, 27, 'still on the river', 0.5);
});

test('a client clock minutes fast does not age the bridge into a stale feed', async (t) => {
  // The feed's newest fix is this ship's; the client clock runs 200 s
  // ahead of the feed and received the refresh just now.
  const skewMs = 200_000;
  const clock = manualClock(t, START_MS + skewMs);
  const record = {
    ...RECORD,
    lastPositionEpoch: START_MS / 1000,
    fixFeedEpoch: START_MS / 1000,
    fixReceivedAtMs: START_MS + skewMs,
  };
  const { $, cockpit, shots } = fixture(t, { record });
  cockpit.enter();
  await settle();
  cockpit.update();
  frames(cockpit, clock, shots, 20);
  await settle();
  assert.match($('#cockpit-aircraft-meta').textContent, /LIVE AIS/);
  assert.doesNotMatch($('#cockpit-aircraft-meta').textContent, /STALE/);
});

test('a fix the feed keeps re-serving goes on ageing into a stale feed', async (t) => {
  const clock = manualClock(t, START_MS);
  // The layer's own records, polled every 30 s with the same fix, as a feed
  // serving its cache does.
  const records = new VesselRecords({ now: () => Date.now() });
  const effects = {
    add() {},
    remove() {},
    beforeUpdate() {},
    updated() {},
    staleSelected() {},
    removed() {},
  };
  const poll = () =>
    records.reconcile(
      [
        {
          ...RECORD,
          last_position_epoch: START_MS / 1000,
        },
      ],
      { complete: true },
      effects,
    );
  poll();
  const record = records.byMmsi.get(RECORD.mmsi);
  const { $, cockpit, shots } = fixture(t, { record });
  cockpit.enter();
  await settle();
  cockpit.update();
  await settle();
  assert.match($('#cockpit-aircraft-meta').textContent, /LIVE AIS/);
  // Seven polls later (210 s), the fix is past the 180 s projection.
  for (let polls = 0; polls < 7; polls += 1) {
    frames(cockpit, clock, shots, 600);
    poll();
  }
  frames(cockpit, clock, shots, 20);
  await settle();
  assert.match($('#cockpit-aircraft-meta').textContent, /STALE FEED/);
});

test('a followed aircraft keeps its own double-click hit area', async (t) => {
  const aircraftInfo = {
    icao24: 'abc123',
    callsign: 'TEST1',
    latitude: 54.5,
    longitude: 10.2,
    altitudeM: 3000,
    velocityMps: 200,
    track: 45,
    onGround: false,
  };
  const { cockpit, viewer, aircraft } = fixture(t, { aircraftInfo });
  viewer.trackedEntity = aircraft;
  heightSensitiveProjection(viewer);
  // Drawn at (400, -2700) as the press begins, at (600, -2700) by the
  // double-click: a click there is not on the aircraft.
  cockpit.onScenePointerDown(1000);
  heightSensitiveProjection(viewer, { x: 600 });
  assert.equal(cockpit.onSceneDoubleClick({ x: 400, y: -2700 }, 1250), false);
  assert.equal(cockpit.active, false);
});

test("a ship's double-click memory does not carry over to an aircraft followed since", async (t) => {
  const aircraftInfo = {
    icao24: 'abc123',
    callsign: 'TEST1',
    latitude: 54.5,
    longitude: 10.2,
    altitudeM: 3000,
    velocityMps: 200,
    track: 45,
    onGround: false,
  };
  const { cockpit, viewer, aircraft } = fixture(t, { aircraftInfo });
  heightSensitiveProjection(viewer);
  // The press finds the ship at (400, 300).
  cockpit.onScenePointerDown(1000);
  // Within the memory, an aircraft is followed, drawn elsewhere.
  viewer.trackedEntity = aircraft;
  heightSensitiveProjection(viewer, { x: 900 });
  assert.equal(cockpit.onSceneDoubleClick({ x: 400, y: 300 }, 1250), false);
  assert.equal(cockpit.active, false);
});

test("a ship's double-click memory does not carry over to another ship", async (t) => {
  const { cockpit, viewer, vessels } = fixture(t);
  heightSensitiveProjection(viewer);
  cockpit.onScenePointerDown(1000);
  // Within the memory another ship is selected, drawn elsewhere.
  vessels.select({ ...RECORD, mmsi: '211000009', name: 'OTHER' });
  heightSensitiveProjection(viewer, { x: 900 });
  assert.equal(cockpit.onSceneDoubleClick({ x: 400, y: 300 }, 1250), false);
  assert.equal(cockpit.active, false);
});

test("a double-click's second press keeps the first press's picture of the ship", async (t) => {
  const { cockpit, viewer, store } = fixture(t);
  heightSensitiveProjection(viewer);
  // The first press finds the ship at (400, 300); the first click
  // re-centres the camera, so the second press finds it at (600, 300).
  cockpit.onScenePointerDown(1000);
  heightSensitiveProjection(viewer, { x: 600 });
  cockpit.onScenePointerDown(1200);
  // By the double-click it has moved again; the gesture began at (400, 300).
  heightSensitiveProjection(viewer, { x: 800 });
  assert.equal(cockpit.onSceneDoubleClick({ x: 400, y: 300 }, 1250), true);
  await settle();
  assert.equal(store.presence.active, true);
});
