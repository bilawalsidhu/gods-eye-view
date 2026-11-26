// The selected train's camera and its visibility from far out: a click on a
// train, moving or not, selects it and centres it once through the shared
// world-focus request (src/data/clickSelect.js); the camera never follows it,
// a drag afterwards keeps the selection, and the selected train's feed stays
// polled at any distance while the rest of the network hides as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { setClickCardHitTest } from '../../data/pickRegistry.js';
import {
  _resetSelectionForTest,
  claimSelection,
  currentSelection,
} from '../../data/clickSelect.js';
import { distance } from '../../geo/vector.js';
import {
  ACTIVATION_EXIT_ALTITUDE_M,
  RAIL_POLL_MS,
  railTrainKey,
} from './policy.js';
import {
  BOSTON,
  railLayerHarness,
  railTrain as train,
  railTrainMoving,
} from '../../testSupport/railLayerHarness.mjs';

const MADRID = { lat: 40.4168, lon: -3.7038 };
const ORBITAL_M = 20_000_000;

function harness(t, options) {
  _resetSelectionForTest();
  t.after(() => _resetSelectionForTest());
  return railLayerHarness(t, options);
}

/**
 * Feed a train reports that move it, poll after poll, until its playback is
 * gliding along them.
 */
async function bringToMotion(app, feedId, id, start) {
  let step = 0;
  app.feeds.set(feedId, () => [
    train(id, start.lat + step * 0.003, start.lon),
    train(`${id}-parked`, start.lat - 0.05, start.lon - 0.05),
  ]);
  await app.enable();
  const key = railTrainKey(feedId, id);
  for (let i = 0; i < 12 && !railTrainMoving(app.entry(key)); i += 1) {
    step += 1;
    app.run(RAIL_POLL_MS);
    await app.poll();
  }
  assert.ok(railTrainMoving(app.entry(key)), 'the train is moving');
  return key;
}

test('a click on a moving train selects it and centres it once; nothing is followed', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  const icons = app.drawn('icons');
  app.click({ set: icons.spec.id, id: key, surface: false });

  assert.equal(app.state()._selectedKey, key);
  assert.equal(app.camera.followed, null, 'not followed');
  assert.equal(app.follows.length, 0);
  assert.equal(app.focusRequests.length, 1, 'one centring flight');
  const request = app.focusRequests[0];
  assert.equal(request.kind, 'train');
  assert.equal(request.id, key);
  assert.equal(request.keepView, true, 'the camera keeps its view');
  assert.ok(distance(request.position, app.entry(key).marker.position) < 1e-6);
  // A copy, never the marker's own vector.
  assert.notEqual(request.position, app.entry(key).marker.position);
  assert.deepEqual(
    { layerId: currentSelection()?.layerId, id: currentSelection()?.id },
    { layerId: 'rail', id: key },
  );

  // A drag, pan and zoom move the map; the train stays selected and nothing
  // takes the camera back to it.
  await app.moveCamera({ lon: BOSTON.lon + 0.2, altitude: 60_000 });
  app.run(2_000);
  await app.moveCamera({ altitude: 8_000 });
  assert.equal(app.state()._selectedKey, key);
  assert.equal(app.camera.followed, null);
  assert.equal(app.focusRequests.length, 1);

  // Clicking it again centres it again, once.
  app.click({ set: icons.spec.id, id: key, surface: false });
  assert.equal(app.focusRequests.length, 2);
  assert.equal(app.camera.followed, null);
});

test('a click on a train selects it; a click on the map lets it go', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  const icons = app.drawn('icons');
  assert.ok(icons.items.has(key), 'the train is drawn as an icon');
  app.click({ set: icons.spec.id, id: key, surface: false });
  assert.equal(app.state()._selectedKey, key);
  app.click(null);
  assert.equal(app.state()._selectedKey, null);
  assert.equal(currentSelection(), null, 'the selection is let go');
  // Its 3D model names it by its pick meta.
  app.click({ set: 'fleet-models', id: 'm1', meta: key, surface: false });
  assert.equal(app.state()._selectedKey, key);
});

// The card or label painted on top takes the click: a train under another
// layer's card is neither selected nor let go.
test("another layer's card over a train keeps the click", async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  const icons = app.drawn('icons');
  let top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
  setClickCardHitTest(() => top);
  t.after(() => setClickCardHitTest(null));
  app.click({ set: icons.spec.id, id: key, surface: false });
  assert.equal(app.state()._selectedKey ?? null, null, 'covered: not selected');
  assert.equal(app.focusRequests.length, 0, 'covered: not flown to');
  top = null;
  app.click({ set: icons.spec.id, id: key, surface: false });
  assert.equal(app.state()._selectedKey, key);
  top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
  app.click(null);
  assert.equal(app.state()._selectedKey, key, 'covered: kept');
});

test('a parked train, or one known from a single report, is centred the same way', async (t) => {
  const app = harness(t);
  await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  const parked = railTrainKey('mbta-rail', 'T1-parked');
  app.parts().selection.selectAndFocusTrain(parked);
  assert.equal(app.camera.followed, null);
  assert.equal(app.focusRequests.length, 1);
  assert.equal(app.focusRequests[0].id, parked);
  assert.equal(app.focusRequests[0].keepView, true);

  app.feeds.set('mbta-rail', () => [
    train('T1', BOSTON.lat, BOSTON.lon),
    train('T1-parked', BOSTON.lat - 0.05, BOSTON.lon - 0.05),
    train('NEW', BOSTON.lat + 0.02, BOSTON.lon + 0.02),
  ]);
  app.run(RAIL_POLL_MS);
  await app.poll();
  const fresh = railTrainKey('mbta-rail', 'NEW');
  app.parts().selection.selectAndFocusTrain(fresh);
  assert.equal(app.camera.followed, null);
  assert.equal(app.focusRequests.at(-1).id, fresh);
});

test('inside the Cockpit the shared request refuses; the train is still selected', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  app.setCockpit(true);
  app.parts().selection.selectAndFocusTrain(key);
  assert.equal(app.camera.followed, null);
  assert.equal(app.focusRequests.length, 1, 'the request carries the refusal');
  assert.equal(app.state()._selectedKey, key, 'the train is still selected');
});

test('Escape lets the train go and leaves the camera where it is', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  app.parts().selection.selectAndFocusTrain(key);
  const cancelled = app.camera.flightsCancelled;
  globalThis.document.dispatchEvent(
    Object.assign(new Event('keydown'), { key: 'Escape' }),
  );
  assert.equal(app.state()._selectedKey, null);
  assert.equal(app.camera.followed, null);
  assert.equal(app.camera.flightsCancelled, cancelled, 'the camera untouched');
});

test("another layer's selection, or a follow it starts, lets the train go", async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  app.parts().selection.selectAndFocusTrain(key);
  // A click on an aircraft selects it without following it.
  claimSelection('flights', 'abc123');
  assert.equal(app.state()._selectedKey, null);
  assert.equal(currentSelection()?.layerId, 'flights', 'not taken back');

  app.parts().selection.selectAndFocusTrain(key);
  assert.equal(currentSelection()?.layerId, 'rail');
  // A Follow on an aircraft.
  const aircraft = {
    key: 'flights:abc123',
    position: () => fromDegrees(-71, 42.3, 3000),
    frame: 'enu',
    viewFrom: { x: 0, y: -1000, z: 500 },
  };
  app.camera.follow(aircraft);
  assert.equal(app.camera.followed, aircraft, 'its follow is untouched');
  assert.equal(app.state()._selectedKey, null);
});

test('a navigation that stops a follow keeps the train selected', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  app.parts().selection.selectAndFocusTrain(key);
  // What the shell's release does before a search or a fly-to.
  app.camera.follow(null);
  assert.equal(app.state()._selectedKey, key);
});

test('selecting another train centres the new one', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  app.parts().selection.selectAndFocusTrain(key);
  const parked = railTrainKey('mbta-rail', 'T1-parked');
  app.parts().selection.selectAndFocusTrain(parked);
  assert.equal(app.state()._selectedKey, parked);
  assert.equal(app.camera.followed, null);
  assert.equal(app.focusRequests.at(-1).id, parked);
  assert.equal(currentSelection()?.id, parked);
});

test('from orbit the selected train and its feed stay; the other trains go as before', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  const parked = railTrainKey('mbta-rail', 'T1-parked');
  app.parts().selection.selectAndFocusTrain(key);

  await app.moveCamera({ altitude: ORBITAL_M });
  assert.ok(ORBITAL_M > ACTIVATION_EXIT_ALTITUDE_M);
  const state = app.state();
  assert.equal(state._heldFeedId, 'mbta-rail');
  assert.ok(state._activeFeeds.has('mbta-rail'), 'its feed is still polled');
  assert.ok(app.entry(key)?.marker?.show, 'the selected train is drawn');
  assert.equal(app.entry(parked), undefined, 'the others have gone');
  assert.equal(state._selectedKey, key, 'and the selection holds');

  // The feed keeps updating, for this train alone.
  const before = app.requested.length;
  const position = { ...app.entry(key).marker.position };
  for (let i = 0; i < 3; i += 1) {
    app.run(RAIL_POLL_MS);
    await app.poll();
  }
  assert.ok(app.requested.length > before);
  assert.equal(app.entry(parked), undefined);
  assert.ok(
    distance(position, app.entry(key).marker.position) > 1,
    'it still moves',
  );
  assert.equal(app.layer.getRouteDisplayStats().heldFeed, 'mbta-rail');

  // Deselecting returns the feed to the viewport's rules: from orbit, gone.
  app.parts().selection.clearSelection();
  await app.recheck();
  assert.equal(state._heldFeedId, null);
  assert.equal(state._activeFeeds.has('mbta-rail'), false);
  assert.equal(state._trains.size, 0);
});

test('a held feed the view wants again brings its other trains back at once', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  const parked = railTrainKey('mbta-rail', 'T1-parked');
  app.parts().selection.selectAndFocusTrain(key);
  await app.moveCamera({ altitude: ORBITAL_M });
  assert.equal(app.entry(parked), undefined);
  const before = app.requested.length;
  await app.moveCamera({ altitude: 30_000 });
  assert.equal(app.state()._heldFeedId, null);
  assert.ok(app.requested.length > before, 'polled at once');
  assert.ok(app.entry(parked), 'the others are back');
  assert.ok(app.entry(key), 'and the selection is kept');
  assert.equal(app.state()._selectedKey, key);
});

test('far side of the globe: the selected train is hidden behind the Earth', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  app.parts().selection.selectAndFocusTrain(key);
  await app.moveCamera({ altitude: ORBITAL_M });
  const marker = app.entry(key).marker;
  const drawn = () => app.drawn('icons').items.get(key)?.show;
  app.moveCameraQuietly({
    position: fromDegrees(BOSTON.lon, BOSTON.lat, ORBITAL_M),
  });
  app.run(250);
  assert.equal(marker.show, true, 'seen from above');
  assert.equal(drawn(), true);
  app.moveCameraQuietly({
    position: fromDegrees(BOSTON.lon + 180, -BOSTON.lat, ORBITAL_M),
  });
  app.run(250);
  assert.equal(marker.show, false, 'hidden from the antipode');
  assert.equal(drawn(), false);
});

test('the selection moves to the copy another feed now draws, with no camera move', async (t) => {
  const app = harness(t, { at: MADRID });
  // One Alvia in two feeds: a station-event copy and, a poll later, a GPS
  // copy that outranks it, so the duplicate filter moves the selection.
  let step = 0;
  let gpsCopy = false;
  const near = (offset) => ({
    lat: MADRID.lat + offset + step * 0.003,
    lon: MADRID.lon,
  });
  app.feeds.set('renfe-cercanias', () => [
    train('A1', near(0).lat, near(0).lon, {
      label: 'ALVIA 4073',
      positionSource: 'event',
    }),
  ]);
  app.feeds.set('renfe-larga-distancia', () =>
    gpsCopy
      ? [
          train('B1', near(0.01).lat, near(0.01).lon, {
            label: '4073',
            positionSource: 'gps',
          }),
        ]
      : [],
  );
  await app.enable();
  const a = railTrainKey('renfe-cercanias', 'A1');
  const b = railTrainKey('renfe-larga-distancia', 'B1');
  for (let i = 0; i < 12 && !railTrainMoving(app.entry(a)); i += 1) {
    step += 1;
    app.run(RAIL_POLL_MS);
    await app.poll();
  }
  assert.ok(railTrainMoving(app.entry(a)));
  app.parts().selection.selectAndFocusTrain(a);
  assert.equal(app.focusRequests.length, 1);

  gpsCopy = true;
  step += 1;
  app.run(RAIL_POLL_MS);
  await app.poll();
  assert.equal(app.state()._selectedKey, b, 'the selection moved');
  assert.equal(currentSelection()?.id, b);
  assert.equal(app.camera.followed, null);
  assert.equal(app.focusRequests.length, 1, 'no new flight');
});

test('a pick selects the train its card names; its card answers for that train only', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  assert.equal(app.layer.pickById(key, { center: false }), true);
  assert.equal(app.state()._selectedKey, key);
  assert.equal(app.focusRequests.length, 0, 'the caller frames it');
  assert.equal(currentSelection()?.id, key);
  assert.equal(app.layer.isSelected(key), true);
  assert.equal(app.layer.isSelected('mbta-rail:T2'), false);
  assert.equal(app.layer.pickById('nowhere:T9'), false);
  app.layer.clearSelection();
  assert.equal(app.state()._selectedKey, null);
  assert.equal(currentSelection(), null);
  assert.equal(app.layer.pickById(key), true);
  assert.equal(app.focusRequests.length, 1, 'centred, as a click');
});
