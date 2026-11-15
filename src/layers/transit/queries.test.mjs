import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueries } from './queries.js';
import { TRANSIT_ENABLED_FEEDS } from '../../data/transitFeeds.js';

test('the empty-coverage note counts regions, not feeds', () => {
  const rio = TRANSIT_ENABLED_FEEDS.filter(
    (feed) => feed.region === 'Rio de Janeiro, RJ',
  );
  assert.equal(rio.length, 2, 'Rio is one region with two feeds');
  const regions = new Set(TRANSIT_ENABLED_FEEDS.map((feed) => feed.region));
  assert.ok(regions.size < TRANSIT_ENABLED_FEEDS.length);

  const stats = createQueries({
    state: {
      _activeFeeds: new Map(),
      _vehicles: new Map(),
      _enabled: true,
      _altitudeGateOpen: true,
    },
    parts: {},
  }).methods.getStats();
  assert.equal(stats.status, 'zoom-in');
  assert.equal(
    stats.coverage,
    `No feed here yet · ${regions.size} regions available`,
  );
});
