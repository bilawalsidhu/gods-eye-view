// The Rail layer's read API for a first-person view: the selected or held
// train as a snapshot (where it is along its line and which way it runs, its
// speed and how that is known, its feed's credit, its stops), and a hold that
// hides its marker and card, keeps it selected and ends when it goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RAIL_POLL_MS, railTrainKey } from './policy.js';
import {
  BOSTON,
  railLayerHarness as harness,
  railTrain as train,
} from '../../testSupport/railLayerHarness.mjs';
import { RAIL_SELECTED_OVERLAY_SOURCE_ID } from './policy.js';
import { publicRailCatalog } from '../../data/railFeeds.js';

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
async function onTheLine(t) {
  const app = harness(t, { paths: { 'mbta-rail': PACK }, at: BOSTON });
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
