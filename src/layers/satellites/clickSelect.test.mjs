// A click on a satellite selects it and centres it once, keeping the camera's
// view, at any height: the camera does not go into orbit with it, a drag
// afterwards keeps the selection, and only an explicit follow follows it
// (src/data/clickSelect.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from './state.js';
import { createTracking } from './tracking.js';
import { createInteraction } from './interaction.js';
import { DESELECT_GLOBE_VIEW } from './policy.js';
import { GLOBE_VIEW } from '../../locations.js';
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
import {
  distance,
  dot,
  eastNorthUp,
  fromDegrees,
  normalize,
  sub,
  toLonLatH,
} from '../../geo/index.js';
import { installGlobeInViewRecovery } from '../../app/globeInViewRecovery.js';
import { globeOutOfFrame } from '../../globeInView.js';
import { worldClock } from '../../time/worldClock.js';
import { readShareFollowSubject } from '../../ui/shareFollow.js';
import { bindClickCamera, dragOnMap } from '../../testSupport/clickCamera.mjs';

const part = (named = {}) =>
  new Proxy(named, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });

const NOW = Date.UTC(2026, 10, 25, 18);
/** Two satellites 400 km up, gliding east at 7.6 km/s. */
const STARTS = { 25544: -97.7, 48274: -90 };
/** A geostationary satellite: still over the equator, 35,786 km up. */
const GEO = 41866;
const GEO_LON = { value: -17.74 };
/** Another, 70° east of Austin. */
const GEO2 = 41867;
const geoAt = (norad, ms) =>
  norad === GEO
    ? { longitude: GEO_LON.value, latitude: 0, altitude: 35_786_000 }
    : norad === GEO2
      ? { longitude: -27.74, latitude: 0, altitude: 35_786_000 }
      : {
          longitude: STARTS[norad] + ((ms - NOW) / 1000) * (7_600 / 111_000),
          latitude: 30.27,
          altitude: 400_000,
        };

function satellitesLayer(t, { height = 20_000, pose = null } = {}) {
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
  const camera = bindClickCamera(viewer, { height, pose });
  const input = fakeInput(viewer);
  const services = {
    overlays: part(),
    picking,
    focus: part(),
    context: part({ getContextStore: () => ({ entities: new Map() }) }),
    readout: part(),
  };
  const state = createState({ services });
  state._enabled = true;
  state._viewer = viewer;
  state.now = () => NOW;
  // The rendering part allocates the tracked sample's ECEF point.
  state._trackedFrameCartesian = { x: 0, y: 0, z: 0 };
  for (const norad of [...Object.keys(STARTS).map(Number), GEO, GEO2]) {
    state._catalog.set(norad, { name: `SAT ${norad}`, satrec: { norad } });
    state._points.set(norad, {});
  }
  const holder = () => ({ id: 'tracked' });
  const parts = {
    rendering: part({
      _addTrackedEntity: holder,
      _hitPointId: (hit) => (hit?.set === 'dots' ? Number(hit.id) : null),
      _hitIsTracked: (hit) => hit?.set === 'tracked',
      _pointPosition: (norad) => {
        const p = geoAt(norad, NOW);
        return fromDegrees(p.longitude, p.latitude, p.altitude);
      },
      _drawnFrameNumber: () => -1,
    }),
    orbits: part({
      propagatePosition: (satrec, date) => geoAt(satrec.norad, date.getTime()),
    }),
    labels: part({ _dockedCompanionNames: () => [] }),
    controls: part({ _pointStyleFor: () => ({ color: '#fff' }) }),
  };
  parts.tracking = createTracking({ state, services, parts });
  const interaction = createInteraction({ state, services, parts });
  interaction._installClickHandler(viewer);
  t.mock.method(console, 'log', () => {});
  t.after(() => {
    state._trackedEntityChangedRemove?.();
    state._clickSubscription?.();
    globalThis.document?.removeEventListener?.(
      'keydown',
      interaction._onKeyDown,
    );
    input.destroy();
    camera.unbind();
    _resetSelectionForTest();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  return {
    state,
    tracking: parts.tracking,
    camera,
    input,
    viewer,
    click(hit) {
      picked = hit ? { id: hit } : null;
      input.tap({ x: 10, y: 10 });
      picked = null;
    },
    /** A click on `hit` with a trail drawn over it. */
    clickUnderTrail(hit) {
      const trail = { id: { set: 'trail:1', id: 'gev-trail:1:head' } };
      picked = trail;
      drilled = [trail, { id: hit }];
      input.tap({ x: 10, y: 10 });
      picked = null;
      drilled = [];
    },
    /** A tap whose exact pick finds only the map, with `hit` in reach. */
    touch(hit) {
      drilled = [{ id: hit }];
      input.tap({ x: 10, y: 10 });
      drilled = [];
    },
  };
}

const DOT = (norad) => ({ set: 'dots', id: String(norad) });

for (const height of [20_000, 20_000_000]) {
  test(`a click on a satellite selects it and centres it once, from ${height / 1000} km`, (t) => {
    const app = satellitesLayer(t, { height });
    const pose = app.camera.port.pose();
    app.click(DOT(25544));
    assert.equal(app.state._trackedNorad, 25544, 'selected');
    assert.equal(app.camera.follows.length, 0, 'not taken into orbit');
    assert.equal(app.camera.followed, null);
    assert.equal(app.camera.flights.length, 1, 'one centring flight');
    // Met where its orbit has it when the flight lands.
    const p = geoAt(25544, NOW + CLICK_CENTER_S * 1000);
    const arrival = fromDegrees(p.longitude, p.latitude, p.altitude);
    const { destination, options } = app.camera.flights[0];
    const look = normalize(sub(arrival, destination));
    assert.ok(distance(look, normalize(pose.direction)) < 1e-9, 'centred');
    assert.deepEqual(options.orientation.direction, pose.direction);
    assert.ok(
      Math.abs(
        distance(destination, arrival) - distance(pose.position, arrival),
      ) < 1e-3,
      'from the same distance',
    );
    assert.equal(currentSelection().layerId, 'satellites');
    assert.equal(currentSelection().subject, app.state._followTarget);
  });
}

test('a drag after the click keeps the satellite selected and the camera free', (t) => {
  const app = satellitesLayer(t);
  app.click(DOT(25544));
  dragOnMap(app.input);
  app.camera.drag({ dLon: 1, height: 400_000 });
  assert.equal(app.state._trackedNorad, 25544);
  assert.equal(app.camera.followed, null);
  assert.equal(app.camera.flights.length, 1);
});

test('a second map click follows the satellite a trail is drawn over', (t) => {
  const app = satellitesLayer(t);
  app.click(DOT(25544));
  assert.equal(app.camera.followed, null);
  app.clickUnderTrail({ set: 'tracked', id: '25544' });
  assert.equal(app.camera.followed, app.state._followTarget);
  assert.equal(app.state._trackedNorad, 25544);
});

test('a second click on the selected satellite follows it; a click on the followed one keeps the follow', (t) => {
  const app = satellitesLayer(t);
  app.click(DOT(25544));
  app.camera.drag();
  app.click({ set: 'tracked', id: '25544' });
  // The same follow the card's Follow starts: the layer's own target.
  assert.equal(app.camera.flights.length, 1, 'not centred again');
  assert.equal(app.camera.followed, app.state._followTarget);
  assert.equal(app.camera.follows.length, 1);
  assert.equal(app.state._trackedNorad, 25544, 'still selected');
  // The share link names the followed satellite.
  const subject = readShareFollowSubject({ viewer: app.viewer });
  assert.equal(subject?.kind, 'satellite');
  assert.equal(subject?.id, '25544');
  // A click on the followed satellite keeps the follow as it is.
  app.click({ set: 'tracked', id: '25544' });
  assert.equal(app.camera.followed, app.state._followTarget);
  assert.equal(app.camera.follows.length, 1, 'no fresh follow');
  assert.equal(app.camera.flights.length, 1);
});

test('a click on another satellite while following selects and centres it; nothing is followed', (t) => {
  const app = satellitesLayer(t);
  app.click(DOT(25544));
  app.click({ set: 'tracked', id: '25544' });
  assert.equal(app.camera.followed, app.state._followTarget);
  app.click(DOT(48274));
  assert.equal(app.state._trackedNorad, 48274);
  assert.equal(app.camera.followed, null);
  assert.equal(app.camera.flights.length, 2);
});

test('another satellite selects that one; the map or another layer lets go', (t) => {
  const app = satellitesLayer(t);
  app.click(DOT(25544));
  app.click(DOT(48274));
  assert.equal(app.state._trackedNorad, 48274);
  assert.equal(app.camera.followed, null);
  app.click(null);
  assert.equal(app.state._trackedNorad, null);
  assert.equal(currentSelection(), null);
  app.click(DOT(25544));
  claimSelection('flights', 'abc123');
  assert.equal(app.state._trackedNorad, null);
});

test('a tap near a satellite on a touch screen selects and centres it', (t) => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = (query) => ({ matches: query.includes('coarse') });
  picking.registerPickOwner('satellites', (id) => /^\d+$/.test(id));
  t.after(() => {
    picking.unregisterPickOwner('satellites');
    if (previous) globalThis.matchMedia = previous;
    else delete globalThis.matchMedia;
  });
  const app = satellitesLayer(t);
  app.touch(DOT(25544));
  assert.equal(app.state._trackedNorad, 25544);
  assert.equal(app.camera.flights.length, 1);
  assert.equal(app.camera.followed, null);
});

test('a geostationary satellite seen from near the ground is framed from above, never slid under the ground to', (t) => {
  // A camera 1 km up over Austin looking south, 70° above the horizon; the
  // satellite 55° up in the south, below the middle of the view.
  const eye = fromDegrees(-97.74, 30.27, 1_000);
  const enu = eastNorthUp(eye);
  const along = (e, n, u) =>
    normalize({
      x: enu.x.x * e + enu.y.x * n + enu.z.x * u,
      y: enu.x.y * e + enu.y.y * n + enu.z.y * u,
      z: enu.x.z * e + enu.y.z * n + enu.z.z * u,
    });
  const pitch = (70 * Math.PI) / 180;
  const pose = {
    position: eye,
    direction: along(0, -Math.cos(pitch), Math.sin(pitch)),
    up: along(0, Math.sin(pitch), Math.cos(pitch)),
  };
  GEO_LON.value = -97.74;
  t.after(() => (GEO_LON.value = -17.74));
  const app = satellitesLayer(t, { pose });
  app.click(DOT(GEO));
  assert.equal(app.state._trackedNorad, GEO);
  assert.equal(app.camera.flights.length, 1);
  const { destination, options } = app.camera.flights[0];
  const p = geoAt(GEO, NOW);
  const sat = fromDegrees(p.longitude, p.latitude, p.altitude);
  const eyeAt = toLonLatH(destination);
  assert.ok(eyeAt.height > p.altitude, 'the eye is above the satellite');
  const towards = normalize(sub(sat, destination));
  assert.ok(
    distance(normalize(options.orientation.direction), towards) < 1e-9,
    'looking at it',
  );
  assert.ok(
    dot(towards, normalize(sat)) < -Math.sin(Math.PI / 4) + 1e-9,
    'down, with the planet behind it',
  );
  assert.ok(distance(destination, sat) >= 0.1 * p.altitude - 1);
  assert.ok(
    Math.abs(dot(options.orientation.up, options.orientation.direction)) < 1e-9,
  );
});

test('a view a click centred on a satellite far out is not swung back to the planet', async (t) => {
  // From 20,000 km over Austin, a geostationary satellite 80° east: centred,
  // the planet leaves the frame.
  const app = satellitesLayer(t, { height: 20_000_000 });
  const recovery = installGlobeInViewRecovery(app.viewer);
  t.after(recovery);
  app.click(DOT(GEO));
  app.camera.land();
  assert.ok(
    globeOutOfFrame(app.camera.port.pose()),
    'the planet is out of the frame',
  );
  assert.deepEqual(app.camera.views, [], 'the view stays on the satellite');
  // Let go, the view is corrected at once, with no move to end.
  app.click(null);
  await Promise.resolve();
  assert.equal(app.camera.views.length, 1, 'turned back to the planet');
});

test('switching from one far satellite to another leaves the view to the next centring', async (t) => {
  const app = satellitesLayer(t, { height: 20_000_000 });
  const recovery = installGlobeInViewRecovery(app.viewer);
  t.after(recovery);
  app.click(DOT(GEO));
  app.camera.land();
  const centred = app.camera.port.pose();
  assert.ok(globeOutOfFrame(centred), 'the planet is out of the frame');
  // The layer lets the first go and selects the second in one turn.
  app.click(DOT(GEO2));
  await Promise.resolve();
  assert.equal(app.state._trackedNorad, GEO2);
  assert.deepEqual(app.camera.views, [], 'not swung to the planet between');
  assert.equal(app.camera.flights.length, 2);
  assert.deepEqual(
    app.camera.flights[1].options.orientation.direction,
    centred.direction,
    'the next centring starts from the view the first left',
  );
});

test('with the world paused, a satellite is centred where it is; at 60x where it will be', (t) => {
  worldClock.seek(NOW);
  worldClock.pause();
  t.after(() => {
    worldClock.setRate(1);
    worldClock.goLive();
  });
  const app = satellitesLayer(t, { height: 20_000_000 });
  const centred = () => {
    const { destination } = app.camera.flights.at(-1);
    const pose = app.camera.port.pose();
    return (ms) => {
      const p = geoAt(25544, ms);
      const at = fromDegrees(p.longitude, p.latitude, p.altitude);
      return distance(
        normalize(sub(at, destination)),
        normalize(pose.direction),
      );
    };
  };
  app.click(DOT(25544));
  assert.ok(centred()(NOW) < 1e-9, 'paused: where it is');
  app.click(null);
  worldClock.setRate(60);
  worldClock.play({ continuous: true });
  app.click(DOT(25544));
  assert.ok(
    centred()(NOW + 60 * CLICK_CENTER_S * 1000) < 1e-9,
    'at 60x: a minute on',
  );
});

test('the globe view letting go flies to is the zoom-to-globe preset', () => {
  assert.equal(DESELECT_GLOBE_VIEW.heightM, GLOBE_VIEW.heightM);
  assert.equal(DESELECT_GLOBE_VIEW.durationS, GLOBE_VIEW.durationS);
  assert.equal(GLOBE_VIEW.pitchDeg, -90);
});

/** The globe view letting go of a followed satellite flies to. */
function assertGlobeViewOver(flight, norad, height) {
  const p = geoAt(norad, NOW);
  assert.deepEqual(flight.destination, {
    lon: p.longitude,
    lat: p.latitude,
    height,
  });
  assert.equal(flight.options.orientation.heading, 0, 'north up');
  assert.ok(
    Math.abs(flight.options.orientation.pitch + Math.PI / 2) < 1e-12,
    'straight down',
  );
  assert.equal(flight.options.orientation.roll, 0, 'level');
  assert.equal(flight.options.endFrame, 'world');
  assert.ok(flight.options.durationS > 0, 'a flight, not a jump');
}

/** Select `norad`, then follow it as a second click does. */
function follow(app, norad) {
  app.click(DOT(norad));
  app.click({ set: 'tracked', id: String(norad) });
  assert.equal(app.camera.followed, app.state._followTarget);
  return app.camera.flights.length;
}

test('a map click letting go of a followed satellite flies to the globe view over its ground point', (t) => {
  const app = satellitesLayer(t);
  const before = follow(app, 25544);
  app.click(null);
  assert.equal(app.state._trackedNorad, null);
  assert.equal(app.camera.followed, null, 'the follow ends');
  assert.equal(app.camera.flights.length, before + 1, 'one flight');
  assertGlobeViewOver(app.camera.flights.at(-1), 25544, 18_000_000);
});

test('Escape letting go of a followed satellite flies to the globe view too', (t) => {
  const app = satellitesLayer(t);
  const before = follow(app, 25544);
  globalThis.document.dispatchEvent(
    Object.assign(new Event('keydown'), { key: 'Escape' }),
  );
  assert.equal(app.state._trackedNorad, null);
  assert.equal(app.camera.flights.length, before + 1);
  assertGlobeViewOver(app.camera.flights.at(-1), 25544, 18_000_000);
});

test('an eye farther out than the globe view keeps its height', (t) => {
  const app = satellitesLayer(t, { height: 60_000_000 });
  const before = follow(app, GEO);
  app.click(null);
  assert.equal(app.camera.flights.length, before + 1);
  assertGlobeViewOver(app.camera.flights.at(-1), GEO, 60_000_000);
});

test('letting go of a satellite the camera does not follow leaves the camera where it is', (t) => {
  const app = satellitesLayer(t);
  app.click(DOT(25544));
  const before = app.camera.flights.length;
  app.click(null);
  assert.equal(app.state._trackedNorad, null);
  assert.equal(app.camera.flights.length, before, 'no flight');
});

test('only a person letting go flies: another layer, another follow or a programmatic stop leave the camera', (t) => {
  const app = satellitesLayer(t);
  // Another layer's selection takes over.
  let before = follow(app, 25544);
  claimSelection('flights', 'abc123');
  assert.equal(app.state._trackedNorad, null);
  assert.equal(app.camera.flights.length, before);
  // Another follow takes the camera.
  before = follow(app, 25544);
  app.camera.port.follow({ key: 'flights:abc123' });
  assert.equal(app.state._trackedNorad, null);
  assert.equal(app.camera.flights.length, before);
  // A stop with no person behind it (a reset, a voice release, the layer
  // turned off) leaves the camera to whatever stopped it.
  before = follow(app, 25544);
  app.tracking._clearTracking(false, { origin: 'tool' });
  assert.equal(app.state._trackedNorad, null);
  assert.equal(app.camera.followed, null);
  assert.equal(app.camera.flights.length, before);
  // A person's stop (the card closed) flies.
  before = follow(app, 25544);
  app.tracking._clearTracking(false, { origin: 'user', globeView: true });
  assert.equal(app.camera.flights.length, before + 1);
  assertGlobeViewOver(app.camera.flights.at(-1), 25544, 18_000_000);
});
