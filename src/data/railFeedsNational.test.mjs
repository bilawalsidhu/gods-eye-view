import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RAIL_ENABLED_FEEDS,
  classifyTrain,
  getRailFeed,
  getRegisteredRailFeed,
} from './railFeeds.js';
import {
  railAdmissionGlobalMax,
  railNaturalRequestsPerMinute,
} from './railProxy.js';

/** One end of a run, as the path build's `readTripEnds` writes it. */
const at = (name, country, state) => ({ name, country, state });
const ends = (
  from,
  to,
  countries = [...new Set([from.country, to.country])],
) => ({ from, to, countries });

/**
 * The category a timetable trip gets: the feed's route rename (when it has
 * one), its trip rename with the run's ends, then its classifier on the pack
 * route id, as the build and the browser apply them.
 */
function tripKind(feedId, route, run = null, trip = { trip_id: 't1' }) {
  const feed = getRegisteredRailFeed(feedId);
  const base =
    (typeof feed.staticRouteRename === 'function'
      ? feed.staticRouteRename(route, { stop: () => null, stateAt: () => null })
      : null) ?? route.route_id;
  const id =
    typeof feed.staticTripRename === 'function'
      ? feed.staticTripRename(trip, base, { ends: run })
      : base;
  return classifyTrain(feed, id, { tripId: trip.trip_id });
}
const category = (...args) => tripKind(...args)?.category ?? null;

test('the national feeds are on and quote their terms', () => {
  for (const id of ['ktmb', 'entur-sj-nord']) {
    assert.ok(getRailFeed(id), `${id} is pollable`);
    assert.ok(getRegisteredRailFeed(id).terms.quote, `${id} quotes its terms`);
  }
});

test('the admission cap grows with the KTMB and SJ Nord feeds', () => {
  const before = RAIL_ENABLED_FEEDS.filter(
    (feed) => !['ktmb', 'entur-sj-nord'].includes(feed.id),
  );
  assert.ok(
    railNaturalRequestsPerMinute() > railNaturalRequestsPerMinute(before),
  );
  assert.ok(railAdmissionGlobalMax() >= railAdmissionGlobalMax(before));
});

test('KTMB: Komuter local, Shuttle Tebrau international, ETS and Intercity by state', () => {
  const route = (id) => ({ route_id: id, route_type: '2' });
  const kl = at('KL SENTRAL', 'MY', 'MY-14');
  const jb = at('JB SENTRAL', 'MY', 'MY-01');
  const tumpat = at('TUMPAT', 'MY', 'MY-03');
  const guaMusang = at('GUA MUSANG', 'MY', 'MY-03');
  // The simplified polygons put Padang Besar station in Thailand.
  const padangBesar = at('PADANG BESAR', 'TH', 'TH-90');
  const butterworth = at('BUTTERWORTH', 'MY', 'MY-07');
  assert.equal(category('ktmb', route('KA15_KD19'), ends(kl, kl)), 'local');
  assert.equal(category('ktmb', route('KC05_KB18')), 'local');
  assert.equal(
    category('ktmb', route('100_47300'), ends(butterworth, padangBesar)),
    'local',
    'Komuter Utara',
  );
  assert.equal(category('ktmb', { route_id: 'SS', route_type: '0' }), 'local');
  assert.equal(category('ktmb', route('ST')), 'international');
  assert.equal(category('ktmb', route('ETS'), ends(kl, jb)), 'national');
  assert.equal(
    category('ktmb', route('ETS'), ends(kl, padangBesar)),
    'national',
    'Padang Besar is in Perlis',
  );
  assert.equal(
    category('ktmb', route('ETS'), ends(kl, at('HAT YAI', 'TH', 'TH-90'))),
    'international',
  );
  assert.equal(
    category(
      'ktmb',
      route('ERT'),
      ends(at('MERAPOH', 'MY', 'MY-06'), at('WOODLANDS CIQ', 'SG', 'SG-03')),
    ),
    'international',
  );
  assert.equal(
    category('ktmb', route('SH'), ends(tumpat, guaMusang)),
    'regional',
  );
  assert.equal(category('ktmb', route('SH')), 'national', 'ends unknown');
  assert.equal(category('ktmb', route('BUS1'), ends(kl, jb)), null);
  // The realtime vehicles carry no route: it comes from the schedule pack.
  assert.equal(getRegisteredRailFeed('ktmb').routesFrom, 'schedule');
  assert.equal(getRegisteredRailFeed('ktmb').pollIntervalMs, 30_000);
});
