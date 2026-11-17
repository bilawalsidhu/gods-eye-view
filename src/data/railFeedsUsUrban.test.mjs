// United States streetcar feeds (Seattle, Cincinnati): switched on with
// their basis, polled for live positions, and sorted into categories with
// the buses dropped.
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

// Licensed and switched on.
const ON = ['seattle-streetcar', 'cincinnati-connector'];

const TRAM = { category: 'transit', mode: 'tram' };

const feed = (id) => getRegisteredRailFeed(id);
const kind = (id, routeId, context) =>
  classifyTrain(feed(id), routeId, context);

test('the US streetcar feeds: licensed feeds on, each with its basis', () => {
  for (const id of ON) {
    assert.ok(getRailFeed(id), `${id} is pollable`);
    assert.ok(RAIL_ENABLED_FEEDS.includes(feed(id)), id);
    assert.ok(feed(id).terms.note, `${id} explains its basis`);
    assert.ok(feed(id).staticGtfsUrl, `${id} has a timetable`);
    assert.ok(feed(id).terms.quote, `${id} quotes its terms`);
    // Nothing personal in the recorded basis.
    assert.doesNotMatch(feed(id).terms.note, /@/, id);
  }
});

test('the US streetcar feeds poll positions and trip updates', () => {
  for (const id of ON) {
    assert.equal(railFeedPositions(feed(id)), 'gps', id);
    assert.ok(railFeedHasTripUpdates(feed(id)), id);
  }
});

test('Seattle Streetcar: the two City of Seattle routes of the King County feed', () => {
  assert.deepEqual(kind('seattle-streetcar', '100340'), TRAM);
  assert.deepEqual(kind('seattle-streetcar', '102638'), TRAM);
  assert.equal(kind('seattle-streetcar', '100001'), null, 'a Metro bus');
  assert.equal(kind('seattle-streetcar', null), null);
  assert.equal(
    feed('seattle-streetcar').attribution,
    'Transit scheduling, geographic, and real-time data provided by permission of King County',
  );
});

test('Cincinnati Connector: the streetcar route, buses dropped', () => {
  assert.deepEqual(kind('cincinnati-connector', '100'), TRAM);
  assert.equal(kind('cincinnati-connector', '78'), null);
});
