// A click on a vessel selects it and centres it once, keeping the camera's
// view; the camera does not follow it, a drag afterwards keeps the
// selection, and one thing is selected at a time across layers
// (src/data/clickSelect.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { clickCard, isOwnedByOtherLayer } from '../../data/pickRegistry.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import {
  _resetSelectionForTest,
  claimSelection,
  currentSelection,
} from '../../data/clickSelect.js';
import { flyToWorldTarget } from '../../worldFocus.js';
import { distance, fromDegrees, normalize, sub } from '../../geo/index.js';
import { bindClickCamera, dragOnMap } from '../../testSupport/clickCamera.mjs';
import { createSelection } from './selection.js';
import { readShareFollowSubject } from '../../ui/shareFollow.js';

const part = (named = {}) =>
  new Proxy(named, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });

function vesselsLayer(t) {
  _resetSelectionForTest();
  let picked = null;
  const viewer = {
    isDestroyed: () => false,
    scene: { canvas: new EventTarget(), pick: () => picked },
  };
  const camera = bindClickCamera(viewer);
  const input = fakeInput(viewer);
  let drawnHeightM = 0;
  const vessel = { id: 'v1', name: 'NORTHERN STAR', lat: 30.2, lon: -97.6 };
  const other = { id: 'v2', name: 'SOUTHERN CROSS', lat: 29.9, lon: -97.1 };
  const state = {
    feed: { enabled: true },
    records: {
      byId: new Map([
        [vessel.id, vessel],
        [other.id, other],
      ]),
    },
    icons: {
      setId: 'vessels:icons',
      has: (id) => id === vessel.id || id === other.id,
    },
    selectedRecord: null,
    interactionKeyTarget: new EventTarget(),
  };
  const focusRequests = [];
  const selection = createSelection({
    vesselState: { state },
    services: {
      picking: { isOwnedByOtherLayer, clickCard },
      // The shell's policy passes a click's request on to this flight.
      worldFocus: {
        requestWorldFocus: (detail) => {
          focusRequests.push(detail);
          return flyToWorldTarget(viewer, detail);
        },
      },
      context: part(),
    },
    parts: {
      queries: {
        reduceVesselSelection: ({ selectedId, pickedId }) =>
          pickedId
            ? { action: pickedId === selectedId ? 'none' : 'select' }
            : { action: selectedId ? 'deselect' : 'none' },
      },
      rendering: part({
        iconPosition: (record) => fromDegrees(record.lon, record.lat, 0),
        // Where the layer draws it now (its placement): read by the follow.
        drawnPositionNow: (record) =>
          fromDegrees(record.lon, record.lat, drawnHeightM),
        getVisual: (record) => ({ iconId: record.id }),
      }),
      cards: part({ displayVesselName: (record) => record.name }),
      photos: part(),
      tracking: part(),
    },
    layer: { source: 'AIS' },
  });
  selection.installInteraction(viewer);
  t.after(() => {
    selection.removeVesselInteraction();
    input.destroy();
    camera.unbind();
    _resetSelectionForTest();
  });
  return {
    state,
    vessel,
    other,
    selection,
    viewer,
    camera,
    /** Move where the layer draws the vessels (their placement). */
    drawAt(heightM) {
      drawnHeightM = heightM;
    },
    input,
    focusRequests,
    click(id) {
      picked = id ? { id: { set: 'vessels:icons', id } } : null;
      input.tap({ x: 10, y: 10 });
      picked = null;
    },
  };
}

test('a click on a vessel selects it and centres it once; nothing is followed', (t) => {
  const app = vesselsLayer(t);
  const pose = app.camera.port.pose();
  app.click('v1');
  assert.equal(app.state.selectedRecord, app.vessel);
  assert.equal(app.focusRequests.length, 1);
  assert.equal(app.focusRequests[0].keepView, true);
  assert.equal(app.camera.flights.length, 1, 'one centring flight');
  assert.equal(app.camera.follows.length, 0);
  assert.equal(app.camera.followed, null);
  const at = fromDegrees(app.vessel.lon, app.vessel.lat, 0);
  const look = normalize(sub(at, app.camera.flights[0].destination));
  assert.ok(distance(look, normalize(pose.direction)) < 1e-9, 'centred');
  assert.equal(currentSelection()?.layerId, 'ais-live-vessels');
});

test('a drag after the click keeps the vessel selected and the camera free', (t) => {
  const app = vesselsLayer(t);
  app.click('v1');
  dragOnMap(app.input);
  app.camera.drag({ dLon: 0.4, height: 80_000 });
  assert.equal(app.state.selectedRecord, app.vessel);
  assert.equal(app.camera.followed, null);
  assert.equal(app.camera.flights.length, 1);
});

test('a second click on the selected vessel follows it where the layer draws it; a click on the followed one keeps the follow', (t) => {
  const app = vesselsLayer(t);
  app.click('v1');
  dragOnMap(app.input);
  app.camera.drag({ dLon: 0.4 });
  app.click('v1');
  assert.equal(app.camera.flights.length, 1, 'not centred again');
  const followed = app.camera.followed;
  assert.equal(followed?.key, 'ais-live-vessels:v1');
  assert.equal(app.camera.follows.length, 1);
  assert.equal(app.state.selectedRecord, app.vessel, 'still selected');
  assert.equal(currentSelection()?.id, 'v1');
  // The camera reads the layer's own placement, as the icon is drawn, and
  // the drawn item where the renderer moves the icons itself.
  assert.deepEqual(followed.item, { set: 'vessels:icons', id: 'v1' });
  app.drawAt(12);
  assert.ok(
    distance(followed.position(0), fromDegrees(-97.6, 30.2, 12)) < 1e-6,
  );
  // The share link names the followed vessel.
  const subject = readShareFollowSubject({ viewer: app.viewer });
  assert.equal(subject?.kind, 'vessel');
  assert.equal(subject?.id, 'v1');
  // A click on the followed vessel keeps the follow as it is.
  app.click('v1');
  assert.equal(app.camera.followed, followed);
  assert.equal(app.camera.follows.length, 1, 'no fresh follow');
});

test('a click on another vessel or the map while following ends the follow', (t) => {
  const app = vesselsLayer(t);
  app.click('v1');
  app.click('v1');
  assert.equal(app.camera.followed?.key, 'ais-live-vessels:v1');
  app.click('v2');
  assert.equal(app.state.selectedRecord, app.other);
  assert.equal(app.camera.followed, null);
  assert.equal(app.camera.flights.length, 2, 'centred once');
  app.click('v2');
  assert.equal(app.camera.followed?.key, 'ais-live-vessels:v2');
  app.click(null);
  assert.equal(app.state.selectedRecord, null);
  assert.equal(app.camera.followed, null);
});

test('the followed vessel selected again stays followed; another layer’s follow lets it go', (t) => {
  const app = vesselsLayer(t);
  app.click('v1');
  app.click('v1');
  const followed = app.camera.followed;
  // Found again in its feed, or picked again.
  app.selection.selectVessel(app.vessel);
  assert.equal(app.camera.followed, followed);
  assert.equal(app.state.followTarget, followed);
  app.camera.port.follow({ key: 'flights:abc123', position: () => null });
  assert.equal(app.state.selectedRecord, null);
});

test('another layer’s selection lets the vessel go; the vessel’s takes it back', (t) => {
  const app = vesselsLayer(t);
  app.click('v1');
  claimSelection('flights', 'abc123');
  assert.equal(app.state.selectedRecord, null);
  assert.equal(currentSelection()?.layerId, 'flights');
  app.click('v1');
  assert.equal(currentSelection()?.layerId, 'ais-live-vessels');
  app.click(null);
  assert.equal(app.state.selectedRecord, null);
  assert.equal(currentSelection(), null);
});
