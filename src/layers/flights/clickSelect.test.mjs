// A click on an aircraft (live flights and military) selects it and centres
// it once, keeping the camera's view; the camera does not follow it, a drag
// afterwards keeps the selection, and only an explicit follow follows it
// (src/data/clickSelect.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlightState as createCivilState } from './state.js';
import { createTracking as createCivilTracking } from './tracking.js';
import { createFlightState as createMilitaryState } from '../military/state.js';
import { createTracking as createMilitaryTracking } from '../military/tracking.js';
import { fakeInput } from '../../input/testDoubles.mjs';
// Registers the trails' pick ids, as the app does on load.
import '../../data/trailRenderer.js';
import * as picking from '../../data/pickRegistry.js';
import {
  CLICK_CENTER_S,
  _resetSelectionForTest,
  claimSelection,
  currentSelection,
} from '../../data/clickSelect.js';
import { distance, fromDegrees, normalize, sub } from '../../geo/index.js';
import { bindClickCamera, dragOnMap } from '../../testSupport/clickCamera.mjs';
import { readShareFollowSubject } from '../../ui/shareFollow.js';

/** A part whose unnamed methods do nothing. */
const part = (named = {}) =>
  new Proxy(named, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });

function services() {
  const names = [
    'sprites',
    'labels',
    'groundFloor',
    'meshFloor',
    'geoid',
    'render',
    'recession',
  ];
  return {
    ...Object.fromEntries(names.map((name) => [name, part()])),
    picking,
    camera: { FOLLOW_MIN_RANGE_M: 150 },
    trails: { createTrail: () => part() },
    aircraftPresentation: part({ isTr3b: () => false }),
    militaryRegistry: part({
      isMilitaryLayerActive: () => false,
      isMilitaryIcao: () => false,
    }),
    focus: part(),
    context: part(),
    readout: part({
      trackedLabelModelFromText: (text) => ({ title: text, details: [] }),
    }),
    groundSnap: { createGroundSnap: () => ({ clear() {} }) },
  };
}

/** Two aircraft flying east at 250 m/s, by display time. */
function fakeIcons() {
  const start = { abc123: -97.7, def456: -97.76 };
  const shown = new Set(Object.keys(start));
  const lonAt = (id, t) => start[id] + (t / 1000) * (250 / 96_000);
  return {
    setId: 'icons',
    has: (id) => id in start,
    position: (id, t) => fromDegrees(lonAt(id, t), 30.27, 10_000),
    course: () => 90,
    setShown: (id, show) => (show ? shown.add(id) : shown.delete(id)),
    shown: (id) => shown.has(id),
    ids: () => Object.keys(start),
    count: 2,
  };
}

const AIRCRAFT_LAYERS = [
  {
    layerId: 'flights',
    shareKind: 'aircraft',
    createState: createCivilState,
    createTracking: createCivilTracking,
  },
  {
    layerId: 'military',
    shareKind: 'military_aircraft',
    createState: createMilitaryState,
    createTracking: createMilitaryTracking,
  },
];

function aircraftLayer(t, { layerId, createState, createTracking }) {
  _resetSelectionForTest();
  const previousDocument = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), {
    body: { classList: { contains: () => false } },
  });
  let picked = null;
  let drilled = [];
  const viewer = {
    isDestroyed: () => false,
    scene: {
      canvas: new EventTarget(),
      pick: () => picked,
      drillPick: () => drilled,
    },
  };
  const camera = bindClickCamera(viewer);
  const input = fakeInput(viewer);
  const flightState = createState({ services: services() });
  flightState._viewer = viewer;
  flightState._icons = fakeIcons();
  let displayMs = 0;
  for (const id of ['abc123', 'def456'])
    flightState.records.data.set(id, {
      callsign: id.toUpperCase(),
      altitude: 10_000,
      altitudeFt: 33_000,
    });
  const tracking = createTracking({
    flightState,
    services: services(),
    parts: {
      icons: part({
        _displayMs: () => displayMs,
        _iconPosition: (id) => flightState._icons.position(id, displayMs),
        _fleetLook: () => ({ size: [24, 24], scaleByDistance: null }),
      }),
      motion: part({
        _trackedDisplayPosition: (id) =>
          flightState._icons.position(id, displayMs),
      }),
      rendering: part({ _groundSampleExclusions: () => ({ sets: [] }) }),
      enrichment: part(),
      queries: part({
        _contactLabel: (id) => id.toUpperCase(),
        _toCleanText: (text) => text,
        _describeFlight: () => null,
      }),
    },
    layer: {},
  });
  tracking._installClickHandler(viewer);
  t.mock.method(console, 'log', () => {});
  t.after(() => {
    flightState._trackedEntityChangedRemove?.();
    flightState._clickSubscription?.();
    input.destroy();
    camera.unbind();
    flightState.lifetime?.abort?.();
    _resetSelectionForTest();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  return {
    flightState,
    tracking,
    camera,
    input,
    viewer,
    /** A click whose pick names `id`'s icon, or the map. */
    click(id) {
      picked = id ? { id: { set: 'icons', id } } : null;
      input.tap({ x: 10, y: 10 });
      picked = null;
    },
    /** A click on `id`'s icon with its trail's head drawn over it. */
    clickUnderTrail(id) {
      const trail = { id: { set: 'trail:1', id: 'gev-trail:1:head' } };
      picked = trail;
      drilled = [trail, { id: { set: 'icons', id } }];
      input.tap({ x: 10, y: 10 });
      picked = null;
      drilled = [];
    },
    advance(ms) {
      displayMs += ms;
    },
    at: (id, ms) => flightState._icons.position(id, ms),
  };
}

for (const kind of AIRCRAFT_LAYERS) {
  test(`${kind.layerId}: a click selects the aircraft and centres it once; nothing is followed`, (t) => {
    const app = aircraftLayer(t, kind);
    const pose = app.camera.port.pose();
    app.click('abc123');

    assert.equal(app.flightState._trackedIcao, 'abc123', 'selected');
    assert.equal(app.camera.follows.length, 0, 'never followed');
    assert.equal(app.camera.followed, null);
    assert.equal(app.camera.flights.length, 1, 'one centring flight');
    // It lands with the plane, where it will be, in the middle, from the
    // camera's own distance and angle.
    const { destination, options } = app.camera.flights[0];
    const arrival = app.at('abc123', CLICK_CENTER_S * 1000);
    const look = normalize(sub(arrival, destination));
    assert.ok(distance(look, normalize(pose.direction)) < 1e-9, 'centred');
    assert.deepEqual(options.orientation.direction, pose.direction);
    // The selection is the one selection, with its card's subject.
    const selection = currentSelection();
    assert.equal(selection.layerId, kind.layerId);
    assert.equal(selection.id, 'abc123');
    assert.equal(selection.subject, app.flightState._followTarget);
  });

  test(`${kind.layerId}: a drag after the click keeps the aircraft selected and the camera free`, (t) => {
    const app = aircraftLayer(t, kind);
    app.click('abc123');
    dragOnMap(app.input);
    app.camera.drag({ dLon: 0.3, height: 60_000 });
    app.advance(5_000);
    app.camera.drag({ dLat: -0.2 });
    assert.equal(app.flightState._trackedIcao, 'abc123');
    assert.equal(app.camera.followed, null);
    assert.equal(app.camera.follows.length, 0);
    assert.equal(app.camera.flights.length, 1, 'no flight back to it');
    assert.equal(currentSelection()?.id, 'abc123');
  });

  test(`${kind.layerId}: a second click on the selected aircraft follows it; a click on the followed one keeps the follow`, (t) => {
    const app = aircraftLayer(t, kind);
    app.click('abc123');
    app.camera.drag();
    app.click('abc123');
    // The same follow the card's Follow starts: the layer's own target.
    assert.equal(app.camera.flights.length, 1, 'not centred again');
    assert.equal(app.camera.followed, app.flightState._followTarget);
    assert.equal(app.camera.follows.length, 1);
    assert.equal(app.flightState._trackedIcao, 'abc123', 'still selected');
    assert.equal(currentSelection()?.id, 'abc123');
    // The share link names the followed aircraft.
    const subject = readShareFollowSubject({ viewer: app.viewer });
    assert.equal(subject?.kind, kind.shareKind);
    assert.equal(subject?.id, 'abc123');
    // A click on the followed aircraft keeps the follow as it is.
    app.click('abc123');
    assert.equal(app.camera.followed, app.flightState._followTarget);
    assert.equal(app.camera.follows.length, 1, 'no fresh follow');
    assert.equal(app.camera.flights.length, 1);
  });

  test(`${kind.layerId}: a click on another aircraft while following selects and centres it; nothing is followed`, (t) => {
    const app = aircraftLayer(t, kind);
    app.click('abc123');
    app.click('abc123');
    assert.equal(app.camera.followed, app.flightState._followTarget);
    app.click('def456');
    assert.equal(app.flightState._trackedIcao, 'def456');
    assert.equal(app.camera.followed, null);
    assert.equal(app.camera.flights.length, 2);
  });

  test(`${kind.layerId}: a drag between the clicks keeps the selection, and the second click still follows`, (t) => {
    const app = aircraftLayer(t, kind);
    app.click('abc123');
    dragOnMap(app.input);
    app.camera.drag({ dLon: 0.3 });
    assert.equal(currentSelection()?.id, 'abc123');
    app.click('abc123');
    assert.equal(app.camera.followed, app.flightState._followTarget);
  });

  test(`${kind.layerId}: a second map click follows the aircraft its trail is drawn over`, (t) => {
    const app = aircraftLayer(t, kind);
    app.click('abc123');
    assert.equal(app.camera.followed, null);
    app.clickUnderTrail('abc123');
    assert.equal(app.camera.followed, app.flightState._followTarget);
    assert.equal(app.flightState._trackedIcao, 'abc123');
  });

  test(`${kind.layerId}: another aircraft's click selects that one; the map lets go`, (t) => {
    const app = aircraftLayer(t, kind);
    app.click('abc123');
    app.click('def456');
    assert.equal(app.flightState._trackedIcao, 'def456');
    assert.equal(app.camera.flights.length, 2);
    assert.equal(app.camera.followed, null);
    assert.equal(currentSelection()?.id, 'def456');
    app.click(null);
    assert.equal(app.flightState._trackedIcao, null);
    assert.equal(currentSelection(), null);
    assert.equal(app.camera.flights.length, 2, 'letting go moves nothing');
  });

  test(`${kind.layerId}: another layer's selection lets the aircraft go`, (t) => {
    const app = aircraftLayer(t, kind);
    app.click('abc123');
    claimSelection('ais-live-vessels', 'v1');
    assert.equal(app.flightState._trackedIcao, null);
    assert.equal(currentSelection()?.layerId, 'ais-live-vessels');
    // Followed, it lets the camera go too.
    app.click('abc123');
    app.tracking._followTracked();
    claimSelection('satellites', '25544');
    assert.equal(app.flightState._trackedIcao, null);
    assert.equal(app.camera.followed, null);
  });

  test(`${kind.layerId}: another layer's card over the aircraft keeps the click`, (t) => {
    const app = aircraftLayer(t, kind);
    let top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
    picking.setClickCardHitTest(() => top);
    t.after(() => picking.setClickCardHitTest(null));
    app.click('abc123');
    assert.equal(app.flightState._trackedIcao ?? null, null);
    assert.equal(app.camera.flights.length, 0);
    top = null;
    app.click('abc123');
    assert.equal(app.flightState._trackedIcao, 'abc123');
  });
}
