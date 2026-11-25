// A click on a transit vehicle selects it and centres it once, keeping the
// camera's view; the camera does not follow it, a drag afterwards keeps the
// selection, and one thing is selected at a time across layers
// (src/data/clickSelect.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeInput } from '../../input/testDoubles.mjs';
import {
  _resetSelectionForTest,
  claimSelection,
  currentSelection,
} from '../../data/clickSelect.js';
import { distance, fromDegrees, normalize, sub } from '../../geo/index.js';
import { bindClickCamera, dragOnMap } from '../../testSupport/clickCamera.mjs';
import { createSelection } from './selection.js';

const part = (named = {}) =>
  new Proxy(named, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });

function transitLayer(t) {
  _resetSelectionForTest();
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  let picked = null;
  const viewer = {
    isDestroyed: () => false,
    scene: { canvas: new EventTarget(), pick: () => picked },
  };
  const camera = bindClickCamera(viewer);
  const input = fakeInput(viewer);
  const bus = {
    key: 'feed:bus7',
    feedId: 'feed',
    marker: { show: true, position: fromDegrees(-97.72, 30.28, 150) },
  };
  const state = {
    _vehicles: new Map([[bus.key, bus]]),
    _activeFeeds: new Map(),
    _overlayHost: part(),
    _selectedKey: null,
    _detectRevision: 0,
    _cockpitSubjectKey: null,
  };
  const selection = createSelection({
    state,
    services: { render: { governorRequestRender() {} } },
    parts: {
      rendering: part({
        setNameOf: (set) => (set === 'transit:moving' ? 'moving' : null),
      }),
      trails: part(),
    },
  });
  selection.installClickHandler(viewer);
  t.after(() => {
    selection.removeClickHandler();
    input.destroy();
    camera.unbind();
    _resetSelectionForTest();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  return {
    state,
    bus,
    camera,
    input,
    click(key) {
      picked = key ? { id: { set: 'transit:moving', id: key } } : null;
      input.tap({ x: 10, y: 10 });
      picked = null;
    },
  };
}

test('a click on a transit vehicle selects it and centres it once; nothing is followed', (t) => {
  const app = transitLayer(t);
  const pose = app.camera.port.pose();
  app.click(app.bus.key);
  assert.equal(app.state._selectedKey, app.bus.key);
  assert.equal(app.camera.flights.length, 1, 'one centring flight');
  assert.equal(app.camera.follows.length, 0);
  assert.equal(app.camera.followed, null);
  const look = normalize(
    sub(app.bus.marker.position, app.camera.flights[0].destination),
  );
  assert.ok(distance(look, normalize(pose.direction)) < 1e-9, 'centred');
  assert.equal(currentSelection()?.layerId, 'transit');
});

test('a drag after the click keeps the vehicle selected and the camera free', (t) => {
  const app = transitLayer(t);
  app.click(app.bus.key);
  dragOnMap(app.input);
  app.camera.drag({ dLon: -0.3, height: 5_000 });
  assert.equal(app.state._selectedKey, app.bus.key);
  assert.equal(app.camera.followed, null);
  assert.equal(app.camera.flights.length, 1);
});

test('another layer’s selection lets the vehicle go, unless a view rides it', (t) => {
  const app = transitLayer(t);
  app.click(app.bus.key);
  claimSelection('satellites', '25544');
  assert.equal(app.state._selectedKey, null);
  app.click(app.bus.key);
  app.state._cockpitSubjectKey = app.bus.key;
  claimSelection('flights', 'abc123');
  assert.equal(app.state._selectedKey, app.bus.key, 'held by its view');
});
