// The Rail layer's read API for a first-person view: the selected or held
// train as a snapshot (where it is along its line and which way it runs, its
// speed and how that is known, its feed's credit, its stops), and a hold that
// hides its marker and card, keeps it selected and ends when it goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RAIL_POLL_MS,
  STOP_REFRESH_MS,
  railTrainFollowable,
  railTrainKey,
} from './policy.js';
import {
  BOSTON,
  railLayerHarness as harness,
  railTrain as train,
} from '../../testSupport/railLayerHarness.mjs';
import { RAIL_SELECTED_OVERLAY_SOURCE_ID } from './policy.js';
import { publicRailCatalog } from '../../data/railFeeds.js';
import { pointAtS } from '../../data/railPaths.js';
import { fleetModelFakes } from '../../testSupport/fleetModelFakes.mjs';

const M_PER_DEG = 111_320;
const LAT = 42.36;
const KX = M_PER_DEG * Math.cos((LAT * Math.PI) / 180);
const LON0 = -71.08;

/** A flat [lat, lon, ...] line due east from LON0, one vertex per 100 m. */
function eastLine(lengthM) {
  const out = [];
  for (let d = 0; d <= lengthM; d += 100) out.push(LAT, LON0 + d / KX);
  return out;
}

const PACK = Object.freeze({
  version: 1,
  feedId: 'mbta-rail',
  builtAt: '2026-09-09T00:00:00.000Z',
  shapes: [eastLine(6000)],
  dist: [[]],
  shapeSources: ['operator'],
  trips: { 'trip-T1': 0, 'trip-T2': 0 },
  routes: { R1: [0] },
});

/** Two trains on the line, T1 running east and T2 west, a step a poll. */
async function onTheLine(t, options = {}) {
  const app = harness(t, {
    paths: { 'mbta-rail': PACK },
    at: BOSTON,
    ...options,
  });
  let step = 0;
  app.feeds.set('mbta-rail', () => [
    train('T1', LAT, LON0 + (1000 + step * 150) / KX, { speedMps: 15 }),
    train('T2', LAT, LON0 + (5000 - step * 150) / KX),
  ]);
  await app.enable();
  for (let i = 0; i < 4; i += 1) {
    step += 1;
    app.run(RAIL_POLL_MS);
    await app.poll();
  }
  return app;
}

const T1 = railTrainKey('mbta-rail', 'T1');
const T2 = railTrainKey('mbta-rail', 'T2');

test('the selected train reads as a snapshot of its place, motion and sources', async (t) => {
  const app = await onTheLine(t);
  assert.equal(app.layer.getSelectedTrain(), null, 'nothing selected');
  app.parts().selection.selectTrain(T1);
  const view = app.layer.getSelectedTrain();
  assert.ok(Object.isFrozen(view));
  assert.equal(view.key, T1);
  assert.equal(view.feedId, 'mbta-rail');
  assert.equal(view.id, 'T1');
  assert.equal(view.tripId, 'trip-T1');
  assert.equal(view.routeId, 'R1');
  assert.equal(view.category, 'regional');
  assert.equal(view.mode, 'rail');
  const listed = publicRailCatalog().find((feed) => feed.id === 'mbta-rail');
  assert.equal(view.feed.attribution, listed.attribution);
  assert.equal(view.feed.license, listed.license);
  assert.equal(view.feed.licenseUrl, listed.licenseUrl);
  assert.equal(view.feed.positions, 'gps');
  assert.equal(view.path.shapeIndex, 0);
  assert.equal(view.path.builtAt, PACK.builtAt);
  assert.equal(view.path.via, 'trip');
  assert.ok(Math.abs(view.path.lengthM - 6000) < 1);
  assert.ok(view.path.s > 1000 && view.path.s < 2000, `s ${view.path.s}`);
  assert.equal(view.path.direction, 1, 'runs along the shape');
  assert.equal(typeof view.path.line.length, 'number');
  assert.equal(view.motion.reportedSpeedMps, 15);
  assert.equal(view.motion.speedSource, 'reported');
  assert.equal(view.provenance.positionSource, 'gps');
  assert.equal(view.provenance.timestampSource, 'vehicle');
  const drawn = app.entry(T1).drawnHeight;
  assert.equal(view.position.railHeightM, drawn.h - 1.5);
  assert.ok(Number.isFinite(view.position.latitude));
  assert.ok(Array.isArray(view.stops));

  app.parts().selection.selectTrain(T2);
  const west = app.layer.getSelectedTrain();
  assert.equal(west.path.direction, -1, 'runs against the shape');
  assert.equal(west.motion.reportedSpeedMps, null);
  assert.equal(
    west.motion.speedSource,
    west.motion.derivedSpeedMps === null ? null : 'derived',
  );
});

/** A trip's stops as a stops provider lists them. */
const stopList = (...names) =>
  names.map((name, i) => ({
    stopId: name,
    name,
    lat: LAT,
    lon: LON0 + (i * 2000) / KX,
    state: 'upcoming',
  }));

test('a snapshot read again while nothing changed is the one read before', async (t) => {
  let list = stopList('Alpha', 'Bravo', 'Charlie');
  const app = await onTheLine(t, {
    stops: { stopsFor: () => ({ stops: list, headsign: 'Charlie' }) },
  });
  app.parts().selection.selectTrain(T1);
  const first = app.layer.getSelectedTrain();
  assert.equal(app.layer.getSelectedTrain(), first, 'the same snapshot');
  // Its stops are frozen copies of the provider's.
  assert.equal(first.stops.length, 3);
  assert.ok(Object.isFrozen(first.stops));
  assert.ok(Object.isFrozen(first.stops[0]));
  assert.notEqual(first.stops[0], list[0]);
  assert.equal(first.stops[0].name, 'Alpha');

  // It moves on: a new snapshot at its new place, what did not change kept.
  app.run(RAIL_POLL_MS);
  await app.poll();
  app.run(RAIL_POLL_MS);
  const moved = app.layer.getSelectedTrain();
  assert.notEqual(moved, first, 'a new snapshot');
  assert.ok(Object.isFrozen(moved) && Object.isFrozen(moved.path));
  assert.ok(moved.path.s > first.path.s, 'at its new place');
  assert.equal(moved.stops, first.stops, 'the same stops');
  assert.equal(moved.feed, first.feed);
  assert.equal(moved.provenance, first.provenance);
  assert.equal(moved.path.line, first.path.line);
  assert.equal(app.layer.getSelectedTrain(), moved);

  // The provider lists other stops: new ones.
  list = stopList('Delta', 'Echo');
  app.run(STOP_REFRESH_MS);
  const later = app.layer.getSelectedTrain();
  assert.notEqual(later.stops, first.stops);
  assert.deepEqual(
    later.stops.map((stop) => stop.name),
    ['Delta', 'Echo'],
  );
  // A provider that updates its list in place: the stops are copied again.
  list[0].state = 'passed';
  app.run(STOP_REFRESH_MS);
  const updated = app.layer.getSelectedTrain();
  assert.notEqual(updated.stops, later.stops);
  assert.equal(updated.stops[0].state, 'passed');
  assert.equal(app.layer.getSelectedTrain().stops, updated.stops);
});

test('a snapshot’s line is a frozen copy: writing to it leaves the layer’s line', async (t) => {
  const app = await onTheLine(t);
  app.parts().selection.selectTrain(T1);
  const { line, s } = app.layer.getSelectedTrain().path;
  const own = app.entry(T1).path.path;
  assert.notEqual(line, own, 'not the layer’s own');
  assert.ok(Object.isFrozen(line));
  for (const name of ['lat', 'lon', 'x', 'y', 's', 'box'])
    assert.ok(Object.isFrozen(line[name]), name);
  const lat = own.lat[1];
  assert.throws(() => {
    line.lat[1] = 0;
  }, TypeError);
  assert.equal(own.lat[1], lat, 'the layer’s line is as it was');
  assert.deepEqual(pointAtS(line, s), pointAtS(own, s), 'it reads the same');
  // Copied once per line: T2 runs on the same one.
  app.parts().selection.selectTrain(T2);
  assert.equal(app.layer.getSelectedTrain().path.line, line);
});

test('a held train hides its marker and card and keeps the selection', async (t) => {
  const app = await onTheLine(t);
  assert.equal(app.layer.setCockpitSubject('rail:mbta-rail:nope'), false);
  assert.equal(app.layer.getCockpitSubject(), null);
  assert.equal(app.layer.setCockpitSubject(T1), true);
  assert.equal(app.state()._selectedKey, T1, 'holding selects it');
  assert.equal(app.layer.getCockpitSubject().key, T1);
  app.run(1000);
  assert.equal(app.entry(T1).marker.show, false);
  assert.equal(app.entry(T2).marker.show, true);
  // From inside the train its selected line would run under the eye.
  assert.equal(app.state()._route.primitive.show, false, 'no line');
  assert.deepEqual(
    app.overlayEntries.get(RAIL_SELECTED_OVERLAY_SOURCE_ID) ?? [],
    [],
    'no card',
  );
  // Escape is the view's while it holds the train.
  globalThis.document.dispatchEvent(
    Object.assign(new Event('keydown'), { key: 'Escape' }),
  );
  assert.equal(app.state()._selectedKey, T1);
  // It still moves.
  const before = app.layer.getCockpitSubject().path.s;
  app.run(RAIL_POLL_MS);
  await app.poll();
  app.run(RAIL_POLL_MS);
  assert.ok(app.layer.getCockpitSubject().path.s > before, 'still moving');

  assert.equal(app.layer.setCockpitSubject(null), true);
  assert.equal(app.layer.getCockpitSubject(), null);
  app.run(1000);
  assert.equal(app.entry(T1).marker.show, true);
  assert.equal(app.state()._route.primitive.show, true, 'the line is back');
  assert.equal(
    (app.overlayEntries.get(RAIL_SELECTED_OVERLAY_SOURCE_ID) ?? []).length,
    1,
    'the card is back',
  );
});

test('a held train draws no 3D model either; let go, its model draws again', async (t) => {
  const models = await fleetModelFakes(t);
  const app = await onTheLine(t, { fleet: models.fleet, altitude: 1_000 });
  // A model's load answers off the frame; the next frames place it.
  const frames = async () => {
    app.run(500);
    await app.settle();
    app.run(500);
  };
  await frames();
  assert.equal(models.drawn(T1).length, 1, 'near the camera: its model');
  assert.equal(app.entry(T1).modelOwnsVisual, true);
  assert.equal(app.entry(T1).marker.show, false, 'its icon hands over');

  assert.equal(app.layer.setCockpitSubject(T1), true);
  app.run(250);
  // The view's eye is inside the train.
  assert.equal(models.drawn(T1).length, 0, 'no model');
  assert.equal(app.entry(T1).modelOwnsVisual, false);
  assert.equal(app.entry(T1).marker.show, false, 'and no icon');
  assert.equal(models.drawn(T2).length, 1, 'another train keeps its model');
  await frames();
  assert.equal(models.drawn(T1).length, 0, 'not on a later frame either');
  assert.equal(app.entry(T1).marker.show, false);

  assert.equal(app.layer.setCockpitSubject(null), true);
  await frames();
  assert.equal(models.drawn(T1).length, 1, 'let go: its model again');
  assert.equal(app.entry(T1).modelOwnsVisual, true);
  assert.equal(app.entry(T1).marker.show, false);
});

const MADRID = { lat: 40.4168, lon: -3.7038 };

test('a held train stays the copy drawn when another feed’s copy outranks it, and keeps moving', async (t) => {
  const app = harness(t, { at: MADRID });
  // One Alvia in two feeds: a station-event copy, held, and a poll later a
  // GPS copy that would outrank it.
  let step = 0;
  let gpsCopy = false;
  const lat = (offset) => MADRID.lat + offset + step * 0.003;
  app.feeds.set('renfe-cercanias', () => [
    train('A1', lat(0), MADRID.lon, {
      label: 'ALVIA 4073',
      positionSource: 'event',
    }),
  ]);
  app.feeds.set('renfe-larga-distancia', () =>
    gpsCopy ? [train('B1', lat(0.01), MADRID.lon, { label: '4073' })] : [],
  );
  await app.enable();
  const a = railTrainKey('renfe-cercanias', 'A1');
  const b = railTrainKey('renfe-larga-distancia', 'B1');
  for (let i = 0; i < 12 && !railTrainFollowable(app.entry(a)); i += 1) {
    step += 1;
    app.run(RAIL_POLL_MS);
    await app.poll();
  }
  assert.ok(railTrainFollowable(app.entry(a)), 'the train is moving');
  assert.equal(app.layer.setCockpitSubject(a), true);

  gpsCopy = true;
  step += 1;
  app.run(RAIL_POLL_MS);
  await app.poll();
  // The view knows the train by its key, and the copies stand apart: the
  // held copy stays drawn and selected, the other is the one hidden.
  assert.equal(app.layer.getCockpitSubject()?.key, a);
  assert.equal(app.state()._selectedKey, a);
  assert.equal(app.entry(a).duplicate, false);
  assert.equal(app.entry(b).duplicate, true);
  assert.equal(app.entry(a).marker.show, false);
  assert.equal(app.entry(b).marker.show, false, 'no other marker on it');
  assert.deepEqual(
    app.overlayEntries.get(RAIL_SELECTED_OVERLAY_SOURCE_ID) ?? [],
    [],
    'no card',
  );
  // It moves between polls, frame by frame.
  assert.ok(app.state()._moving.has(app.entry(a)), 'still playing');
  const before = app.layer.getCockpitSubject().position.latitude;
  app.run(2000);
  assert.ok(
    app.layer.getCockpitSubject().position.latitude > before,
    'still moving',
  );

  // Let go: the better copy takes over at the next poll, with the selection.
  app.layer.setCockpitSubject(null);
  step += 1;
  app.run(RAIL_POLL_MS);
  await app.poll();
  assert.equal(app.entry(a).duplicate, true);
  assert.equal(app.entry(b).duplicate, false);
  assert.equal(app.state()._selectedKey, b);
  assert.equal(app.entry(b).marker.show, true);
  assert.equal(
    (app.overlayEntries.get(RAIL_SELECTED_OVERLAY_SOURCE_ID) ?? []).length,
    1,
    'its card',
  );
  // The copy hidden is not focused: the selection stays on the one drawn.
  assert.equal(app.layer.focusTrain(a), false);
  assert.equal(app.state()._selectedKey, b);

  // A hold of the copy hidden draws it at once, in place of the other.
  assert.equal(app.layer.setCockpitSubject(a), true);
  assert.equal(app.state()._selectedKey, a);
  assert.equal(app.entry(a).duplicate, false);
  assert.equal(app.entry(b).duplicate, true);
  assert.equal(app.entry(b).marker.show, false);
  assert.ok(app.state()._moving.has(app.entry(a)), 'playing');
});

test('a held train keeps the selection and moves, hidden, when its category is turned off', async (t) => {
  const app = await onTheLine(t);
  app.layer.setCockpitSubject(T1);
  app.run(1000);
  assert.ok(app.state()._moving.has(app.entry(T1)), 'playing');
  app.layer.setParams({ regional: false });
  assert.equal(app.state()._selectedKey, T1, 'still selected');
  assert.equal(app.layer.getCockpitSubject()?.key, T1);
  assert.equal(app.entry(T1).marker.show, false);
  assert.equal(app.entry(T2).marker.show, false, 'its category is hidden');
  assert.equal(app.state()._route.primitive.show, false, 'no line');
  assert.deepEqual(
    app.overlayEntries.get(RAIL_SELECTED_OVERLAY_SOURCE_ID) ?? [],
    [],
    'no card',
  );
  // It moves between polls, frame by frame.
  assert.ok(app.state()._moving.has(app.entry(T1)), 'still playing');
  const before = app.layer.getCockpitSubject().path.s;
  app.run(2000);
  assert.ok(app.layer.getCockpitSubject().path.s > before, 'still moving');
  assert.equal(app.entry(T1).marker.show, false, 'and still hidden');

  // Let go: a train of a hidden category, deselected and stopped as the
  // toggle would have left it.
  app.layer.setCockpitSubject(null);
  assert.equal(app.state()._selectedKey, null);
  assert.equal(app.state()._moving.has(app.entry(T1)), false);
  assert.equal(app.entry(T1).marker.show, false);
  const parked = app.entry(T1).path.drawS;
  app.run(2000);
  assert.equal(app.entry(T1).path.drawS, parked, 'stopped');
  // Held again, hidden, it plays at once; let go, it stops again.
  assert.equal(app.layer.setCockpitSubject(T1), true);
  assert.ok(app.state()._moving.has(app.entry(T1)), 'playing at once');
  app.layer.setCockpitSubject(null);
  assert.equal(app.state()._moving.has(app.entry(T1)), false);
  // Shown again, it is drawn and moves as any other.
  app.layer.setParams({ regional: true });
  assert.equal(app.entry(T1).marker.show, true);
  assert.ok(app.state()._moving.has(app.entry(T1)), 'playing again');
});

test('a ride let go with restore does not focus a train its category hides', async (t) => {
  const app = await onTheLine(t);
  // The documented provider: hold on entry; on exit, release, then focus
  // the train again when asked to restore.
  assert.equal(app.layer.setCockpitSubject(T1), true);
  app.layer.setParams({ regional: false });
  app.layer.setCockpitSubject(null);
  assert.equal(app.layer.focusTrain(T1), false, 'not drawn');
  assert.equal(app.state()._selectedKey, null, 'not selected');
  assert.equal(app.parts().follow.stats(), null, 'not followed');
  assert.equal(app.viewer.trackedEntity, undefined);
  assert.equal(app.focusRequests.length, 0, 'not flown to');
  assert.equal(app.entry(T1).marker.show, false);

  // Shown again, it focuses as before.
  app.layer.setParams({ regional: true });
  assert.equal(app.layer.focusTrain(T1), true);
  assert.equal(app.state()._selectedKey, T1);
  assert.ok(app.parts().follow.isFollowing(T1), 'the camera is handed to it');
});

test('a held train that goes takes the hold with it; focusTrain selects', async (t) => {
  const app = await onTheLine(t);
  app.layer.setCockpitSubject(T1);
  app.feeds.set('mbta-rail', () => [train('T2', LAT, LON0 + 4000 / KX)]);
  for (let i = 0; i < 3; i += 1) {
    app.run(RAIL_POLL_MS);
    await app.poll();
  }
  assert.equal(app.entry(T1), undefined, 'the train is gone');
  assert.equal(app.layer.getCockpitSubject(), null);
  assert.equal(app.state()._cockpitSubjectKey, null);
  assert.equal(app.layer.focusTrain(T1), false);
  assert.equal(app.layer.focusTrain(T2), true);
  assert.equal(app.state()._selectedKey, T2);
});

test('a held train its feed drops leaves the feed polled until the view lets go', async (t) => {
  const app = await onTheLine(t);
  app.layer.setCockpitSubject(T1);
  // From the cab the camera looks along the ground, here past the feed's range.
  await app.moveCamera({ lat: 40.71, lon: -74.0 });
  assert.equal(app.state()._heldFeedId, 'mbta-rail', 'held for the train');
  const others = () => [train('T2', LAT, LON0 + 4000 / KX)];
  app.feeds.set('mbta-rail', others);
  for (let i = 0; i < 3; i += 1) {
    app.run(RAIL_POLL_MS);
    await app.poll();
  }
  await app.recheck();
  assert.equal(app.entry(T1), undefined, 'the train is gone');
  assert.equal(app.layer.getCockpitSubject(), null);
  assert.ok(app.state()._activeFeeds.has('mbta-rail'), 'its feed is polled');
  await app.moveCamera({ lat: 40.72, lon: -74.0 });
  assert.ok(app.state()._activeFeeds.has('mbta-rail'), 'whatever the camera');

  // Listed again: the view holds it again.
  app.feeds.set('mbta-rail', () => [
    train('T1', LAT, LON0 + 2500 / KX, { speedMps: 15 }),
    ...others(),
  ]);
  app.run(RAIL_POLL_MS);
  await app.poll();
  assert.equal(app.layer.setCockpitSubject(T1), true);
  assert.equal(app.state()._cockpitLostFeedId, null);
  assert.equal(app.state()._selectedKey, T1);

  // Let go, and the feed is the viewport's again: out of range, released.
  app.parts().ingestion.removeTrain(T1);
  assert.equal(app.state()._cockpitLostFeedId, 'mbta-rail');
  app.layer.setCockpitSubject(null);
  await app.moveCamera({ lat: 40.71, lon: -74.0 });
  assert.equal(app.state()._activeFeeds.has('mbta-rail'), false);
  assert.equal(app.state()._trains.size, 0);
});

test('selectedAtMs is the user’s selection time, never a hold’s or another train’s', async (t) => {
  const app = await onTheLine(t);
  assert.equal(app.layer.focusTrain(T1), true);
  const first = app.layer.getSelectedTrain().selectedAtMs;
  assert.ok(Number.isFinite(first), 'a click or focusTrain stamps it');
  // Selected again: a later stamp.
  app.run(1000);
  app.layer.focusTrain(T1);
  assert.ok(app.layer.getSelectedTrain().selectedAtMs > first);
  // A hold of another train is not the user's selection.
  app.layer.setCockpitSubject(T2);
  assert.equal(app.layer.getCockpitSubject().key, T2);
  assert.equal(app.layer.getCockpitSubject().selectedAtMs, null);
  app.layer.setCockpitSubject(null);
  // Nor after a deselection (Escape), then a hold.
  app.layer.focusTrain(T1);
  globalThis.document.dispatchEvent(
    Object.assign(new Event('keydown'), { key: 'Escape' }),
  );
  assert.equal(app.state()._selectedKey, null);
  assert.equal(app.state()._selectedAtMs, null, 'deselection clears it');
  app.layer.setCockpitSubject(T2);
  assert.equal(app.layer.getCockpitSubject().selectedAtMs, null);
  // Releasing twice is harmless: the selection stays.
  assert.equal(app.layer.setCockpitSubject(null), true);
  assert.equal(app.layer.setCockpitSubject(null), true);
  assert.equal(app.state()._selectedKey, T2);
  assert.equal(app.layer.getCockpitSubject(), null);
});

test('turning the layer off ends the hold', async (t) => {
  const app = await onTheLine(t);
  app.layer.setCockpitSubject(T1);
  app.parts().ingestion.removeTrain(T1);
  assert.equal(app.state()._cockpitLostFeedId, 'mbta-rail');
  app.layer.disable(app.viewer);
  assert.equal(app.state()._cockpitSubjectKey, null);
  assert.equal(app.state()._cockpitLostFeedId, null);
  assert.equal(app.layer.getCockpitSubject(), null);
});
