import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueries } from './queries.js';
import { formatKnots } from '../../data/detectionDraw.js';

function setup(count = 20) {
  const records = Array.from({ length: count }, (_, i) => ({
    mmsi: String(i),
    name: `Ship ${i}`,
    type: 'tanker',
    speed: 12,
    billboard: { show: true, position: { x: i, y: 0, z: 0 } },
  }));
  const state = {
    feed: { enabled: true },
    billboardCollection: { show: true },
    records: { all: records },
    selectedRecord: null,
  };
  const { methods } = createQueries({
    vesselState: { state },
    services: { labels: { formatKnots } },
    parts: { rendering: { getVisual: (record) => record } },
  });
  return {
    records,
    state,
    get: (options) => methods.getDetectableObjects(options),
  };
}

test('stride sampling preserves membership/order for hidden records, caps and signed seeds', () => {
  const { records, get } = setup(39);
  records[8].billboard.show = false;
  for (const maxCount of [1, 5, 15, 39])
    for (const seed of [-9, -1, 0, 1, 8]) {
      const stride = Math.max(1, Math.ceil(records.length / maxCount));
      const expected = records
        .filter(
          (r, i) => (i - (seed % stride)) % stride === 0 && r.billboard.show,
        )
        .slice(0, maxCount)
        .map((r) => r.mmsi);
      assert.deepEqual(
        get({ maxCount, seed }).map((row) => row.sourceId),
        expected,
      );
    }
});

test('reused vessel candidates immediately reflect new fixes, text, types, speeds and selection', () => {
  const { records, state, get } = setup(1);
  const first = get()[0];
  assert.equal(first.metric, '12 kn');
  assert.equal(get()[0], first);
  records[0].name = 'New name';
  records[0].type = 'passenger';
  records[0].speed = 24;
  records[0].billboard.position = { x: 8, y: 9, z: 10 };
  state.selectedRecord = records[0];
  const updated = get()[0];
  assert.equal(updated.id, 'New name');
  assert.equal(updated.klass, 'PASSENGER');
  assert.equal(updated.metric, '24 kn');
  assert.equal(updated.position, records[0].billboard.position);
  assert.equal(updated.skipLabel, true);
  records[0].billboard.show = false;
  assert.deepEqual(get(), []);
  records[0].billboard.show = true;
  state.selectedRecord = null;
  records[0].speed = null;
  assert.equal(get()[0].skipLabel, false);
  assert.equal(get()[0].metric, '');
  state.feed.enabled = false;
  assert.deepEqual(get(), []);
});
