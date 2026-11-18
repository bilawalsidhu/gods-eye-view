// A United States feed whose publisher states no terms (Charlotte LYNX):
// switched on with the reason recorded, and sorted into categories.
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
import { keepsRouteType } from '../../scripts/build-rail-paths.mjs';

// The feeds that publish no terms, used without a published licence by project
// owner decision of 2026-11-10.
const ON = ['charlotte-lynx'];
const BASIS =
  'Publishes no terms; used without a published licence (project owner decision, 2026-11-10).';

const TRAM = { category: 'transit', mode: 'tram' };

const feed = (id) => getRegisteredRailFeed(id);
const kind = (id, routeId, context) =>
  classifyTrain(feed(id), routeId, context);

test('the no-terms feed is on and says why', () => {
  for (const id of ON) {
    const entry = feed(id);
    assert.ok(getRailFeed(id), `${id} is pollable`);
    assert.ok(RAIL_ENABLED_FEEDS.includes(entry), id);
    assert.equal(entry.license, 'No licence published', id);
    assert.ok(entry.terms.note.startsWith(BASIS), id);
    // Nothing personal in the recorded basis.
    assert.doesNotMatch(entry.terms.note, /@/, id);
  }
});

test('Charlotte LYNX: live light rail and streetcar with trip updates, buses dropped', () => {
  const lynx = feed('charlotte-lynx');
  assert.equal(railFeedPositions(lynx), 'gps');
  assert.ok(railFeedHasTripUpdates(lynx));
  assert.match(
    lynx.staticGtfsUrl,
    /^https:\/\/gtfsrealtime\.ridetransit\.org\//,
  );
  // Routes seen live on 2026-11-10: 501 Blue Line, 510 Gold Line, buses.
  assert.deepEqual(kind('charlotte-lynx', '501'), TRAM);
  assert.deepEqual(kind('charlotte-lynx', '510'), TRAM);
  for (const bus of ['9', '22', '5', null])
    assert.equal(kind('charlotte-lynx', bus), null, String(bus));
});

test('a listed staticRouteTypes is the whole list, so trains coded as buses build', () => {
  assert.equal(keepsRouteType({}, '3'), false, 'a bus by default');
  assert.equal(keepsRouteType({}, ' 2 '), true);
  assert.equal(keepsRouteType({ staticRouteTypes: [3] }, '3'), true);
  assert.equal(keepsRouteType({ staticRouteTypes: [3] }, '2'), false);
  assert.equal(keepsRouteType({ staticRouteTypes: [0, 2] }, '0'), true);
  assert.equal(keepsRouteType({ staticRouteTypes: [0, 2] }, '1'), false);
  assert.equal(keepsRouteType({ staticRouteTypes: [3] }, ''), false);
});
