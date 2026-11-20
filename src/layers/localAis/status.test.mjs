import test from 'node:test';
import assert from 'node:assert/strict';
import { layerFeedState } from '../../data/feedState.js';
import { localAisStatus } from './status.js';

const feed = (n, status) => ({
  label: `AIS receiver ${n}`,
  status,
  count: status === 'live' ? 1 : 0,
});
const stats = (options) => localAisStatus({ heard: 0, ...options });
const state = (options) => layerFeedState({ count: 0, ...stats(options) });

test('not configured is guidance, not STALE or an error', () => {
  const result = stats({ configured: false, feeds: [] });
  assert.equal(result.status, 'idle');
  assert.equal(result.statusMessage, 'not configured');
  assert.equal(result.error, undefined);
  assert.notEqual(result.stale, true);
  assert.equal(state({ configured: false }), 'nominal');
});

test('every feed live is nominal and says how many are heard', () => {
  const result = stats({
    configured: true,
    feeds: [feed(1, 'live'), feed(2, 'live')],
    heard: 7,
  });
  assert.equal(result.loadingLabel, '2 feeds live · 7 vessels heard');
  assert.equal(
    state({ configured: true, feeds: [feed(1, 'live')], heard: 1 }),
    'nominal',
  );
});

test('an empty or deaf receiver is STALE, dated like Local ADS-B, never live', () => {
  const feeds = [feed(1, 'stale')];
  const result = stats({ configured: true, feeds });
  assert.equal(result.status, 'stale');
  assert.equal(result.stale, true);
  assert.equal(result.error, undefined);
  assert.equal(state({ configured: true, feeds }), 'stale');
});

test('a stale row never hides a sibling feed that is misconfigured', () => {
  const result = stats({
    configured: true,
    feeds: [feed(1, 'stale'), feed(2, 'invalid')],
  });
  assert.equal(result.error, 'feed 1 stale · feed 2 invalid');
  assert.notEqual(result.stale, true);
});

test('a singular vessel is counted as one vessel', () => {
  const result = stats({
    configured: true,
    feeds: [feed(1, 'live')],
    heard: 1,
  });
  assert.equal(result.loadingLabel, '1 feed live · 1 vessel heard');
});

test('a receiver sending rejected rows is not "no recent messages"', () => {
  const rejected = {
    ...feed(1, 'stale'),
    dropped: 3,
    rejected: 3,
    heardAt: null,
  };
  const result = stats({ configured: true, feeds: [rejected] });
  assert.equal(result.error, 'feed 1 rejected');
  assert.equal(result.stale, undefined);
  assert.equal(state({ configured: true, feeds: [rejected] }), 'unavailable');
});

test('rows left out by design (base stations, aids to navigation) are not a fault', () => {
  // dropped counts them; rejected does not.
  const quiet = { ...feed(1, 'stale'), dropped: 5, rejected: 0, heardAt: null };
  const result = stats({ configured: true, feeds: [quiet] });
  assert.equal(result.status, 'stale');
  assert.equal(result.error, undefined);
  assert.equal(result.statusMessage, 'no recent messages');
  assert.equal(state({ configured: true, feeds: [quiet] }), 'stale');
});

test('old usable rows beside fresh rejected rows report the rejection, not an ordinary STALE', () => {
  const mixed = { ...feed(1, 'stale'), dropped: 3, rejected: 2, heardAt: 1 };
  const result = stats({ configured: true, feeds: [mixed] });
  assert.equal(result.error, 'feed 1 rejected');
  assert.notEqual(result.status, 'stale');
  // Old rows alone, with nothing rejected, stay a quiet receiver.
  const old = { ...feed(1, 'stale'), dropped: 3, rejected: 0, heardAt: 1 };
  assert.equal(stats({ configured: true, feeds: [old] }).status, 'stale');
});

test('a rejecting feed beside a live feed is named as rejected, not as stale', () => {
  const rejected = {
    ...feed(2, 'stale'),
    dropped: 2,
    rejected: 2,
    heardAt: null,
  };
  const result = stats({
    configured: true,
    feeds: [feed(1, 'live'), rejected],
    heard: 3,
  });
  assert.equal(result.loadingLabel, '3 vessels heard · feed 2 rejected');
  assert.equal(result.status, 'streaming');
  // A merely quiet sibling still reads stale.
  const quiet = { ...feed(2, 'stale'), dropped: 4, rejected: 0 };
  assert.equal(
    stats({ configured: true, feeds: [feed(1, 'live'), quiet], heard: 3 })
      .loadingLabel,
    '3 vessels heard · feed 2 stale',
  );
});

test('nominal needs at least one vessel heard at snapshot time', () => {
  // The server counted a live feed, but nothing is left in the window here.
  const live = [feed(1, 'live'), feed(2, 'live')];
  const result = stats({ configured: true, feeds: live, heard: 0 });
  assert.equal(result.status, 'stale');
  assert.equal(result.loadingLabel, undefined);
  assert.equal(state({ configured: true, feeds: live, heard: 0 }), 'stale');
  // A live feed next to a stale one is not nominal with 0 heard either.
  const mixed = stats({
    configured: true,
    feeds: [feed(1, 'live'), feed(2, 'stale')],
    heard: 0,
  });
  assert.equal(mixed.status, 'stale');
  assert.equal(mixed.loadingLabel, undefined);
  // One vessel is enough to be nominal again.
  assert.equal(
    state({ configured: true, feeds: [feed(1, 'live')], heard: 1 }),
    'nominal',
  );
});

test('a mix of live and failing feeds stays up but names the failing ones', () => {
  const result = stats({
    configured: true,
    feeds: [feed(1, 'live'), feed(2, 'unreachable'), feed(3, 'stale')],
    heard: 4,
  });
  assert.equal(
    result.loadingLabel,
    '4 vessels heard · feed 2 unreachable · feed 3 stale',
  );
  assert.equal(result.stale, undefined);
  assert.equal(result.error, undefined);
});

test('an unreachable receiver is an error that names the feed', () => {
  const result = stats({
    configured: true,
    feeds: [feed(1, 'unreachable'), feed(2, 'stale')],
  });
  assert.equal(result.error, 'feed 1 unreachable · feed 2 stale');
  assert.equal(
    state({ configured: true, feeds: [feed(1, 'unreachable')] }),
    'unavailable',
  );
});

test('a configuration error is distinct from an unreachable receiver', () => {
  const result = stats({
    configured: true,
    feeds: [feed(1, 'invalid'), feed(2, 'invalid')],
  });
  assert.equal(result.error, 'feeds 1, 2 invalid');
  assert.notEqual(
    result.error,
    stats({
      configured: true,
      feeds: [feed(1, 'unreachable')],
    }).error,
  );
});

test('a failed route request is reported as an unavailable receiver', () => {
  const result = stats({ configured: true, feeds: [], requestFailed: true });
  assert.equal(result.error, 'Local AIS receiver unavailable');
});

test('a receiver that heard only a beacon is heard, never "no recent messages"', () => {
  const only = stats({
    configured: true,
    feeds: [feed(1, 'live')],
    heard: 0,
    beacons: 1,
  });
  assert.equal(only.status, 'streaming');
  assert.equal(only.stale, undefined);
  assert.equal(only.statusMessage, undefined);
  assert.equal(only.loadingLabel, '1 feed live · 1 beacon heard');
  assert.equal(
    state({
      configured: true,
      feeds: [feed(1, 'live')],
      heard: 0,
      beacons: 1,
    }),
    'nominal',
  );
  const several = stats({
    configured: true,
    feeds: [feed(1, 'live')],
    heard: 0,
    beacons: 3,
  });
  assert.equal(several.loadingLabel, '1 feed live · 3 beacons heard');
});

test('vessels and beacons are counted apart, and neither hides the other', () => {
  assert.equal(
    stats({
      configured: true,
      feeds: [feed(1, 'live'), feed(2, 'live')],
      heard: 2,
      beacons: 1,
    }).loadingLabel,
    '2 feeds live · 2 vessels heard · 1 beacon heard',
  );
  assert.equal(
    stats({
      configured: true,
      feeds: [feed(1, 'live'), feed(2, 'stale')],
      heard: 1,
      beacons: 2,
    }).loadingLabel,
    '1 vessel heard · 2 beacons heard · feed 2 stale',
  );
  // Nothing of either kind left is quiet, not nominal.
  const none = stats({
    configured: true,
    feeds: [feed(1, 'live')],
    heard: 0,
    beacons: 0,
  });
  assert.equal(none.status, 'stale');
  assert.equal(none.statusMessage, 'no recent messages');
});
