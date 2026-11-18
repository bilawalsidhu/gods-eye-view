// Tri-Rail, South Florida's commuter line: switched on with its basis,
// polled for live positions, and sorted into categories by route or by
// train number.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RAIL_ENABLED_FEEDS,
  classifyTrain,
  getRailFeed,
  getRegisteredRailFeed,
  railFeedHasTripUpdates,
  railFeedPositions,
} from './railFeeds.js';

const feed = (id) => getRegisteredRailFeed(id);
const kind = (id, routeId, context) =>
  classifyTrain(feed(id), routeId, context);

test('Tri-Rail is on, with its basis', () => {
  const tri = feed('tri-rail');
  assert.ok(getRailFeed('tri-rail'), 'pollable');
  assert.ok(RAIL_ENABLED_FEEDS.includes(tri));
  assert.ok(tri.terms.quote, 'quotes its terms');
  assert.ok(tri.terms.note, 'explains its basis');
  // Used by project owner decision, which it says, naming no person.
  assert.match(tri.terms.note, /\(project owner decision, 2026-11-10\)/);
  assert.doesNotMatch(tri.terms.note, /@/);
});

test('Tri-Rail: live positions with trip updates, trains by route or train number', () => {
  const tri = feed('tri-rail');
  assert.equal(railFeedPositions(tri), 'gps');
  assert.ok(railFeedHasTripUpdates(tri));
  assert.equal(tri.staticGtfsUrl, 'https://gtfs.tri-rail.com/gtfs.zip');
  const local = { category: 'local', mode: 'rail' };
  // Pack routes: Mainline and Downtown Miami Link.
  assert.deepEqual(kind('tri-rail', '1'), local);
  assert.deepEqual(kind('tri-rail', '2'), local);
  // The airport shuttle bus, should a route id ever reach the classifier.
  assert.equal(kind('tri-rail', '4'), null);
  // Realtime vehicles carry no route, only the train number.
  assert.deepEqual(kind('tri-rail', null, { tripId: 'P617' }), local);
  assert.deepEqual(kind('tri-rail', '', { tripId: 'P601X' }), local);
  assert.equal(kind('tri-rail', null, { tripId: 'FLA Loop_T01' }), null);
  assert.equal(kind('tri-rail', null, {}), null);
});
