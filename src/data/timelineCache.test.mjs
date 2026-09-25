import test from 'node:test';
import assert from 'node:assert/strict';

import { TimelineCache } from './timelineCache.js';

test('TimelineCache stores snapshots and retrieves closest historical record', () => {
  const cache = new TimelineCache({ maxSnapshots: 10, useIndexedDB: false });

  const t0 = 1000000;
  const t1 = 1030000;
  const t2 = 1060000;

  cache.recordSnapshot(
    [{ id: 'FLIGHT-A', lat: 10, lon: 20, alt: 3000, heading: 90, speed: 250 }],
    t0,
  );

  cache.recordSnapshot(
    [
      {
        id: 'FLIGHT-A',
        lat: 10.1,
        lon: 20.2,
        alt: 3100,
        heading: 90,
        speed: 250,
      },
    ],
    t1,
  );

  cache.recordSnapshot(
    [
      {
        id: 'FLIGHT-A',
        lat: 10.2,
        lon: 20.4,
        alt: 3200,
        heading: 90,
        speed: 250,
      },
    ],
    t2,
  );

  // Exact query
  const res1 = cache.getEntitiesAtTime(t1);
  assert.equal(res1.length, 1);
  assert.equal(res1[0].lat, 10.1);

  // Midpoint query (closest to t1)
  const resMid = cache.getEntitiesAtTime(1035000);
  assert.equal(resMid.length, 1);
  assert.equal(resMid[0].lat, 10.1);

  // Range query
  const range = cache.getTimeRange();
  assert.equal(range.startMs, t0);
  assert.equal(range.endMs, t2);
  assert.equal(range.count, 3);
});

test('TimelineCache caps at maxSnapshots ring buffer limit', () => {
  const cache = new TimelineCache({ maxSnapshots: 3, useIndexedDB: false });

  for (let i = 0; i < 5; i++) {
    cache.recordSnapshot([{ id: `E-${i}`, lat: i, lon: i }], 1000 + i * 100);
  }

  const range = cache.getTimeRange();
  assert.equal(range.count, 3);
  assert.equal(range.startMs, 1200); // 1000 and 1100 were shifted out
  assert.equal(range.endMs, 1400);
});
