// The selected train's camera and its visibility from far out: a moving train
// is followed through the camera port (as an aircraft is), any other
// train is flown to once, and the selected train's feed stays polled at any
// distance while the rest of the network hides as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLLOW_MIN_RANGE_M,
  followViewFrom,
  SELECTION_FOLLOW_TRANSITION_S,
} from '../../data/trackedCamera.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { setClickCardHitTest } from '../../data/pickRegistry.js';
import { distance } from '../../geo/vector.js';
import {
  ACTIVATION_EXIT_ALTITUDE_M,
  FOLLOW_HANDOVER_MS,
  RAIL_POLL_MS,
  railFollowOffset,
  railTrainFollowable,
  railTrainKey,
} from './policy.js';
import { WORLD_FOCUS_FRAMING } from '../../worldFocus.js';
import { createTrack, insertFix } from '../../data/contactPlayback.js';
import {
  BOSTON,
  RAIL_HARNESS_T0 as T0,
  railLayerHarness as harness,
  railTrain as train,
} from '../../testSupport/railLayerHarness.mjs';

const MADRID = { lat: 40.4168, lon: -3.7038 };
const ORBITAL_M = 20_000_000;

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
  for (let i = 0; i < 12 && !railTrainFollowable(app.entry(key)); i += 1) {
    step += 1;
    app.run(RAIL_POLL_MS);
    await app.poll();
  }
  assert.ok(railTrainFollowable(app.entry(key)), 'the train is moving');
  return key;
}

test('the follow offset is the shared train framing seen along the heading', () => {
  const framing = WORLD_FOCUS_FRAMING.train;
  const north = railFollowOffset(framing, 0);
  // Behind (south of) the train and above it, looking north and down.
  assert.ok(Math.abs(north.x) < 1e-9);
  assert.ok(north.y < 0 && north.z > 0);
  const range = Math.hypot(north.x, north.y, north.z);
  assert.ok(Math.abs(range - framing.rangeM) < 1e-6);
  const pitch = (Math.atan2(north.z, -north.y) * 180) / Math.PI;
  assert.ok(Math.abs(pitch + framing.pitchDeg) < 1e-9);
  // Facing east: the camera stands west of the train.
  const east = railFollowOffset(framing, Math.PI / 2);
  assert.ok(east.x < 0 && Math.abs(east.y) < 1e-6);
});

/** A playback track of reports 15 s apart at these [lat, lon] places. */
function trackOf(points) {
  const track = createTrack();
  points.forEach(([lat, lon], i) =>
    insertFix(track, { t: T0 + i * 15_000, lat, lon }, { replayed: true }),
  );
  return track;
}

test('a train is followed while it moves, and not once it is parked or unheard', () => {
  const entry = (fields, points = [[BOSTON.lat, BOSTON.lon]]) => ({
    sample: { phase: 'playing', latestReportAgeMs: 20_000, ...fields },
    track: trackOf(points),
  });
  const moved = [
    [BOSTON.lat, BOSTON.lon],
    [BOSTON.lat + 0.003, BOSTON.lon],
  ];
  const parked = [
    [BOSTON.lat, BOSTON.lon],
    [BOSTON.lat + 0.00005, BOSTON.lon],
  ];
  // Gliding between two reports.
  assert.equal(railTrainFollowable(entry({ segmentSpeedMps: 25 })), true);
  // Dwelling at a stop with its departure already reported.
  assert.equal(
    railTrainFollowable(
      entry({
        segmentSpeedMps: 0,
        motion: 'stopped',
        displayT: 1_000,
        nextMotionT: 31_000,
      }),
    ),
    true,
  );
  // Between reports: the playback waits at the latest one (or is still
  // buffering) after the last two moved it; this is a moving train.
  for (const phase of ['held', 'buffering'])
    assert.equal(
      railTrainFollowable(
        entry({ phase, segmentSpeedMps: 0, motion: 'unknown' }, moved),
      ),
      true,
      phase,
    );
  // Parked: the last reports are one place (GPS jitter aside), and nothing
  // says it will move.
  assert.equal(
    railTrainFollowable(
      entry(
        {
          segmentSpeedMps: 0,
          motion: 'stopped',
          displayT: 1_000,
          nextMotionT: Infinity,
        },
        parked,
      ),
    ),
    false,
  );
  // A single report, a train not heard from lately, or no playback at all.
  assert.equal(
    railTrainFollowable(
      entry({ phase: 'held', segmentSpeedMps: 0, motion: 'unknown' }),
    ),
    false,
  );
  assert.equal(
    railTrainFollowable(
      entry({ segmentSpeedMps: 25, latestReportAgeMs: 120_000 }, moved),
    ),
    false,
  );
  assert.equal(railTrainFollowable({}), false);
  assert.equal(railTrainFollowable(null), false);
});

test('selecting a moving train hands the camera a follow target that rides on its marker', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  app.moveCameraQuietly({ heading: Math.PI / 4 });
  const cancelled = app.camera.flightsCancelled;
  const pose = app.camera.pose();
  const at = { ...app.entry(key).marker.position };
  app.parts().selection.selectAndFocusTrain(key);

  const target = app.camera.followed;
  assert.ok(target, 'the camera follows a target');
  assert.equal(app.focusRequests.length, 0, 'no one-shot fly-to');
  assert.equal(app.camera.flightsCancelled, cancelled + 1);
  // Framed as the aircraft are (once, never closer than their minimum),
  // from where the camera already is: its distance and angle kept, the train
  // gliding to the centre.
  assert.equal(app.follows.length, 1);
  assert.equal(target.frame, 'enu');
  assert.equal(target.minRange, FOLLOW_MIN_RANGE_M);
  assert.equal(target.transitionS, SELECTION_FOLLOW_TRANSITION_S);
  const expected = followViewFrom(pose, at);
  assert.ok(Math.abs(target.viewFrom.x - expected.x) < 1e-6);
  assert.ok(Math.abs(target.viewFrom.y - expected.y) < 1e-6);
  assert.ok(Math.abs(target.viewFrom.z - expected.z) < 1e-6);

  // The target stands where the marker is drawn, frame after frame.
  const marker = app.entry(key).marker;
  for (let i = 0; i < 4; i += 1) {
    app.run(1_000);
    const shown = app.trackedPosition();
    assert.ok(distance(shown, marker.position) < 1e-6, 'on the marker');
    assert.notEqual(shown, marker.position, 'a copy');
  }
  assert.ok(app.layer.getRouteDisplayStats().follow.tracked);

  // Picking the followed train again keeps the follow as it is.
  app.parts().selection.selectAndFocusTrain(key);
  assert.equal(app.camera.followed, target);
  assert.equal(app.follows.length, 1);
});

test('a click on a train selects it; a click on the map lets it go', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  const icons = app.drawn('icons');
  assert.ok(icons.items.has(key), 'the train is drawn as an icon');
  app.click({ set: icons.spec.id, id: key, surface: false });
  assert.equal(app.state()._selectedKey, key);
  assert.ok(app.camera.followed);
  // Its 3D model names it by its pick meta.
  app.click(null);
  assert.equal(app.state()._selectedKey, null);
  assert.equal(app.camera.followed, null);
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
  top = null;
  app.click({ set: icons.spec.id, id: key, surface: false });
  assert.equal(app.state()._selectedKey, key);
  top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
  app.click(null);
  assert.equal(app.state()._selectedKey, key, 'covered: kept');
});

test('a parked train, or one known from a single report, is flown to once', async (t) => {
  const app = harness(t);
  await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  const parked = railTrainKey('mbta-rail', 'T1-parked');
  assert.equal(railTrainFollowable(app.entry(parked)), false);
  app.parts().selection.selectAndFocusTrain(parked);
  assert.equal(app.camera.followed, null);
  assert.equal(app.follows.length, 0);
  assert.equal(app.focusRequests.length, 1);
  const request = app.focusRequests[0];
  assert.equal(request.kind, 'train');
  assert.equal(request.id, parked);
  assert.ok(
    distance(request.position, app.entry(parked).marker.position) < 1e-6,
  );
  // A copy, never the marker's own vector.
  assert.notEqual(request.position, app.entry(parked).marker.position);

  // A second click flies again, as for a vessel.
  app.parts().selection.selectAndFocusTrain(parked);
  assert.equal(app.focusRequests.length, 2);

  // A train with one report has no motion to follow.
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

test('inside the Cockpit a moving train is not followed: the shared request refuses', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  app.setCockpit(true);
  app.parts().selection.selectAndFocusTrain(key);
  assert.equal(app.camera.followed, null);
  assert.equal(app.focusRequests.length, 1, 'the request carries the refusal');
  assert.equal(app.state()._selectedKey, key, 'the train is still selected');
});

test('deselecting or Escape lets go of the camera where it is', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);

  app.parts().selection.selectAndFocusTrain(key);
  assert.ok(app.camera.followed);
  app.parts().selection.clearSelection();
  assert.equal(app.camera.followed, null);
  assert.equal(app.state()._follow, null);

  app.parts().selection.selectAndFocusTrain(key);
  assert.ok(app.camera.followed);
  globalThis.document.dispatchEvent(
    Object.assign(new Event('keydown'), { key: 'Escape' }),
  );
  assert.equal(app.state()._selectedKey, null);
  assert.equal(app.camera.followed, null);
});

test('orbiting and zooming around the train keep the follow, as for an aircraft', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  app.parts().selection.selectAndFocusTrain(key);
  const target = app.camera.followed;
  // Camera input while following moves the camera around the target;
  // nothing here changes what is followed, so the follow stays.
  await app.moveCamera({ altitude: 60_000 });
  app.run(2_000);
  await app.moveCamera({ altitude: 8_000 });
  assert.equal(app.camera.followed, target);
  assert.ok(app.parts().follow.isFollowing(key));
});

test('another camera owner ends the follow: a tracked aircraft takes the selection too', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  app.parts().selection.selectAndFocusTrain(key);

  // An aircraft layer follows its contact.
  const aircraft = {
    key: 'flights:abc123',
    position: () => fromDegrees(-71, 42.3, 3000),
    frame: 'enu',
    viewFrom: { x: 0, y: -1000, z: 500 },
  };
  app.camera.follow(aircraft);
  assert.equal(app.camera.followed, aircraft, 'its follow is untouched');
  assert.equal(app.state()._selectedKey, null);
  assert.equal(app.state()._follow, null);
});

test('a navigation that releases the follow camera keeps the train selected', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  app.parts().selection.selectAndFocusTrain(key);
  // What the shell's release does before a search or a fly-to.
  app.camera.follow(null);
  assert.equal(app.state()._selectedKey, key);
  assert.equal(app.state()._follow, null);
  // Picking the train again takes the camera back.
  app.parts().selection.selectAndFocusTrain(key);
  assert.ok(app.parts().follow.isFollowing(key));
});

test('selecting another train hands the camera over with a fresh frame', async (t) => {
  const app = harness(t);
  const key = await bringToMotion(app, 'mbta-rail', 'T1', BOSTON);
  app.parts().selection.selectAndFocusTrain(key);
  assert.ok(app.camera.followed);
  const parked = railTrainKey('mbta-rail', 'T1-parked');
  app.parts().selection.selectAndFocusTrain(parked);
  assert.equal(app.camera.followed, null, 'the follow let go');
  assert.equal(app.focusRequests.at(-1).id, parked, 'and the new train flew');
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
  assert.ok(app.camera.followed, 'and the follow holds');

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
  app.camera.follow(null); // the camera is free to go round
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

test('the follow glides to the copy another feed now draws, without letting go', async (t) => {
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
  for (let i = 0; i < 12 && !railTrainFollowable(app.entry(a)); i += 1) {
    step += 1;
    app.run(RAIL_POLL_MS);
    await app.poll();
  }
  assert.ok(railTrainFollowable(app.entry(a)));
  app.parts().selection.selectAndFocusTrain(a);
  const target = app.camera.followed;
  assert.ok(target);
  const onA = app.trackedPosition();

  gpsCopy = true;
  step += 1;
  app.run(RAIL_POLL_MS);
  await app.poll();
  assert.equal(app.state()._selectedKey, b, 'the selection moved');
  assert.equal(app.camera.followed, target, 'the same follow');
  assert.equal(app.follows.length, 1, 'no new frame: no jump');
  assert.equal(app.focusRequests.length, 0);
  assert.ok(app.parts().follow.isFollowing(b));
  // It starts where it stood, then glides onto the new copy.
  const start = app.trackedPosition();
  assert.ok(distance(start, onA) < 50, 'no jump at the handover');
  app.run(FOLLOW_HANDOVER_MS + 250);
  const settled = app.trackedPosition();
  assert.ok(
    distance(settled, app.entry(b).marker.position) < 1e-6,
    'on the new copy',
  );
});
