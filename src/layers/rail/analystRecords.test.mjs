// The trains the Context panel and the analyst read: one record per counted
// train, at its last reported position, keyed by the layer's own key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { railTrainKey } from './policy.js';
import {
  BOSTON,
  railLayerHarness as harness,
  railTrain as train,
} from '../../testSupport/railLayerHarness.mjs';

test('rail lists each counted train with a position, a key and a name', async (t) => {
  const app = harness(t, { at: BOSTON });
  assert.deepEqual(app.layer.getAnalystRecords(), []);
  app.feeds.set('mbta-rail', () => [
    train('T1', BOSTON.lat + 0.01, BOSTON.lon, {
      speedMps: 20,
      label: 'Train 101',
    }),
    train('T2', BOSTON.lat + 0.02, BOSTON.lon),
  ]);
  await app.enable();
  const records = app.layer.getAnalystRecords();
  assert.equal(records.length, 2);
  const first = records.find((r) => r.id === railTrainKey('mbta-rail', 'T1'));
  assert.ok(first);
  assert.equal(first.name, 'Train 101');
  assert.equal(first.lat, BOSTON.lat + 0.01);
  assert.equal(first.lon, BOSTON.lon);
  assert.equal(first.speedMps, 20);
  assert.equal(first.route, 'R1');
  assert.equal(first.category, 'regional');
  assert.ok(Number.isFinite(first.observedMs));
  assert.equal(app.layer.getAnalystRecords(1).length, 1);

  // Another feed's copy is not counted, so it is not listed either.
  app.entry(railTrainKey('mbta-rail', 'T2')).duplicate = true;
  assert.equal(app.layer.getAnalystRecords().length, 1);
  assert.equal(
    app.layer.getAnalystRecords().length,
    app.layer.getStats().count,
  );
});
