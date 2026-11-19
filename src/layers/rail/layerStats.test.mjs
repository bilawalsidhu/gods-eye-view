// What the layer row and stats count: trains drawn, a train two feeds carry
// once, and a partial snapshot when the train cap leaves trains out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrack } from '../../data/contactPlayback.js';
import { layerFeedState } from '../../data/feedState.js';
import { MAX_TRAINS_TOTAL, railTrainKey } from './policy.js';
import {
  BOSTON,
  railLayerHarness as harness,
  railTrain as train,
} from '../../testSupport/railLayerHarness.mjs';

const near = (i) => ({
  lat: BOSTON.lat + 0.001 * i,
  lon: BOSTON.lon + 0.001 * i,
});

test('a train another feed draws is not counted twice', async (t) => {
  const app = harness(t, { at: BOSTON });
  app.feeds.set('mbta-rail', () =>
    [1, 2, 3].map((i) => train(`T${i}`, near(i).lat, near(i).lon)),
  );
  await app.enable();
  assert.equal(app.layer.getStats().count, 3);
  // The duplicate filter hides T3 as another feed's copy of a train.
  app.entry(railTrainKey('mbta-rail', 'T3')).duplicate = true;
  const stats = app.layer.getStats();
  assert.equal(stats.count, 2);
  assert.match(stats.coverage, /MBTA 2\b/);
  const legend = app.layer.getRowControls().legend;
  assert.deepEqual(
    legend.map((item) => item.count),
    [2],
  );
});

/** Trains of another feed held by the layer, outside the view. */
function fill(app, count, { duplicate }) {
  for (let i = 0; i < count; i += 1) {
    const key = railTrainKey('elsewhere', `F${i}`);
    app.state()._trains.set(key, {
      key,
      feedId: 'elsewhere',
      category: 'regional',
      duplicate,
      marker: null,
      track: createTrack(),
      fetchedAt: Date.now(),
      record: {
        id: `F${i}`,
        lat: -40 + (i % 80),
        lon: 100 + Math.floor(i / 80),
        timestamp: Math.floor(Date.now() / 1000),
      },
    });
  }
}

test('copies hidden as duplicates do not count toward the train cap', async (t) => {
  const app = harness(t, { at: BOSTON });
  let trains = [];
  app.feeds.set('mbta-rail', () => trains);
  await app.enable();
  fill(app, MAX_TRAINS_TOTAL - 1, { duplicate: true });
  trains = [1, 2, 3].map((i) => train(`T${i}`, near(i).lat, near(i).lon));
  await app.poll();
  for (const i of [1, 2, 3])
    assert.ok(app.entry(railTrainKey('mbta-rail', `T${i}`)), `T${i}`);
  assert.equal(app.state()._feedStatus.get('mbta-rail').capped, 0);
  assert.notEqual(app.layer.getStats().partial, true);
});

test('trains the cap leaves out make the snapshot partial', async (t) => {
  const app = harness(t, { at: BOSTON });
  let trains = [];
  app.feeds.set('mbta-rail', () => trains);
  await app.enable();
  const warn = t.mock.method(console, 'warn', () => {});
  fill(app, MAX_TRAINS_TOTAL - 2, { duplicate: false });
  trains = [1, 2, 3, 4, 5].map((i) => train(`T${i}`, near(i).lat, near(i).lon));
  await app.poll();
  const kept = [1, 2, 3, 4, 5].filter((i) =>
    app.entry(railTrainKey('mbta-rail', `T${i}`)),
  );
  assert.equal(kept.length, 2);
  assert.equal(app.state()._feedStatus.get('mbta-rail').capped, 3);
  const stats = app.layer.getStats();
  assert.equal(stats.partial, true);
  assert.equal(stats.rawRowCount - stats.acceptedRowCount, 3);
  // The panel row reads it as PARTIAL (a feed in range that the harness
  // does not answer would read as degraded first).
  assert.equal(layerFeedState({ ...stats, degraded: false }), 'partial');
  assert.equal(warn.mock.callCount(), 1);
  // Room again: the next poll draws them all, and the note goes.
  for (const [key, entry] of app.state()._trains)
    if (entry.feedId === 'elsewhere') app.state()._trains.delete(key);
  await app.poll();
  assert.equal(app.state()._feedStatus.get('mbta-rail').capped, 0);
  assert.notEqual(app.layer.getStats().partial, true);
});
