// A click on a satellite selects it and centres it once, keeping the camera's
// view, at any height: the camera does not go into orbit with it, a drag
// afterwards keeps the selection, and only an explicit follow follows it
// (src/data/clickSelect.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from './state.js';
import { createTracking } from './tracking.js';
import { createInteraction } from './interaction.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import * as picking from '../../data/pickRegistry.js';
import {
  CLICK_CENTER_S,
  _resetSelectionForTest,
  claimSelection,
  currentSelection,
} from '../../data/clickSelect.js';
import { distance, fromDegrees, normalize, sub } from '../../geo/index.js';
import { bindClickCamera, dragOnMap } from '../../testSupport/clickCamera.mjs';

const part = (named = {}) =>
  new Proxy(named, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });

const NOW = Date.UTC(2026, 10, 25, 18);
/** Two satellites 400 km up, gliding east at 7.6 km/s. */
const STARTS = { 25544: -97.7, 48274: -90 };
const geoAt = (norad, ms) => ({
  longitude: STARTS[norad] + ((ms - NOW) / 1000) * (7_600 / 111_000),
  latitude: 30.27,
  altitude: 400_000,
});

function satellitesLayer(t, { height = 20_000 } = {}) {
  _resetSelectionForTest();
  const previousDocument = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), {
    body: { classList: { contains: () => false } },
  });
  let picked = null;
  const viewer = {
    isDestroyed: () => false,
    scene: { canvas: new EventTarget(), pick: () => picked },
  };
  const camera = bindClickCamera(viewer, { height });
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
  for (const norad of Object.keys(STARTS).map(Number)) {
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
    click(hit) {
      picked = hit ? { id: hit } : null;
      input.tap({ x: 10, y: 10 });
      picked = null;
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

test('a click on the selected satellite centres it again; Follow follows it', (t) => {
  const app = satellitesLayer(t);
  app.click(DOT(25544));
  app.click({ set: 'tracked', id: '25544' });
  assert.equal(app.camera.flights.length, 2);
  assert.equal(app.camera.followed, null);
  app.tracking._followTracked();
  assert.equal(app.camera.followed, app.state._followTarget);
  app.click({ set: 'tracked', id: '25544' });
  assert.equal(app.camera.flights.length, 2, 'a follow keeps it centred');
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
