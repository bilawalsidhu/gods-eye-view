import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalAisLayer, LOCAL_AIS_LAYER_ID } from './index.js';
import { layerFeedState } from '../../data/feedState.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

// Placeholder MMSIs; an open-ocean position.
const SERVER_NOW = 1_800_000_000_000;

const vessel = (n, extra = {}) => ({
  id: `local-ais:20000000${n}`,
  mmsi: `20000000${n}`,
  name: `TEST ${n}`,
  lat: 30.5,
  lon: -40.5,
  speed: 9.4,
  course: 77,
  heading: null,
  shipType: 70,
  shipClass: 0,
  destination: '',
  approx: false,
  validated: true,
  lastSeenAt: SERVER_NOW - 5000,
  source: 'local-ais',
  ...extra,
});
const beacon = (n, kind = 'sart', extra = {}) =>
  vessel(n, {
    id: `local-ais:97000000${n}`,
    mmsi: `97000000${n}`,
    name: '',
    speed: null,
    course: null,
    shipClass: 13,
    beaconType: kind,
    ...extra,
  });
const feed = (n, status, extra = {}) => ({
  label: `AIS receiver ${n}`,
  status,
  count: status === 'live' ? 1 : 0,
  dropped: 0,
  heardAt: null,
  ...extra,
});
const snapshot = (patch = {}) => ({
  configured: true,
  generatedAt: SERVER_NOW,
  feeds: [feed(1, 'live', { heardAt: SERVER_NOW - 5000, count: 1 })],
  records: [vessel(1)],
  ...patch,
});

async function setup(initial, options = {}) {
  const clock = { now: SERVER_NOW };
  const responses = { next: initial };
  const calls = [];
  const viewer = { scene: {} };
  const { draw } = bindFakeDraw(viewer);
  const entries = [];
  const layer = createLocalAisLayer({
    now: () => clock.now,
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      const reply = responses.next;
      if (reply instanceof Error) throw reply;
      return {
        ok: reply.ok !== false,
        json: async () => reply.body ?? reply,
      };
    },
    ...options,
    overlayHost: options.overlayHost ?? {
      setEntries: (source, list) => entries.push([source, list]),
      setVisible() {},
    },
  });
  layer.init(viewer);
  layer.enable();
  return { layer, clock, responses, calls, draw, entries };
}
const markers = (draw) =>
  [...draw.sets.values()].find((s) => s.spec.id === 'local-ais:markers');

test('the layer is Local AIS, local-only polling of the vessels route', async (t) => {
  const { layer, calls } = await setup(snapshot());
  t.after(() => layer.destroy());
  assert.equal(layer.id, LOCAL_AIS_LAYER_ID);
  assert.equal(layer.name, 'Local AIS');
  assert.equal(await layer.update(), true);
  assert.equal(calls[0][0], '/api/local-receivers/vessels');
});

test('nothing is fetched or drawn while the layer is off', async (t) => {
  const { layer, calls, draw } = await setup(snapshot());
  t.after(() => layer.destroy());
  layer.disable();
  assert.equal(await layer.update(), false);
  assert.equal(calls.length, 0);
  assert.equal(markers(draw).show, false);
});

test('a live snapshot draws one marker per vessel and reads nominal', async (t) => {
  const { layer, draw } = await setup(snapshot());
  t.after(() => layer.destroy());
  await layer.update();
  assert.deepEqual([...markers(draw).items.keys()], ['local-ais:200000001']);
  const stats = layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.loadingLabel, '1 feed live · 1 vessel heard');
  assert.equal(layerFeedState(stats), 'nominal');
});

test('an unconfigured server reads as guidance, not STALE or an error', async (t) => {
  const { layer, draw } = await setup({
    configured: false,
    feeds: [],
    records: [],
  });
  t.after(() => layer.destroy());
  await layer.update();
  const stats = layer.getStats();
  assert.equal(stats.statusMessage, 'not configured');
  assert.equal(stats.lastUpdate, null);
  assert.equal(layerFeedState(stats), 'nominal');
  assert.equal(markers(draw).items.size, 0);
});

test('a reachable receiver with no vessels reads STALE and is dated by its last message', async (t) => {
  const polled = SERVER_NOW + 30_000;
  const { layer, clock } = await setup(
    snapshot({
      generatedAt: polled,
      feeds: [feed(1, 'stale', { heardAt: polled - 700_000 })],
      records: [],
    }),
  );
  t.after(() => layer.destroy());
  clock.now = polled;
  await layer.update();
  const stats = layer.getStats();
  assert.equal(layerFeedState(stats), 'stale');
  assert.equal(stats.statusMessage, 'no recent messages');
  // The data age is the receiver's last message, not the time of this poll.
  assert.equal(stats.lastUpdate, polled - 700_000);
  assert.notEqual(stats.lastUpdate, clock.now);
});

test('an empty receiver that never heard anything has no data age at all', async (t) => {
  const { layer } = await setup(
    snapshot({ feeds: [feed(1, 'stale')], records: [] }),
  );
  t.after(() => layer.destroy());
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, null);
  assert.equal(layerFeedState(layer.getStats()), 'stale');
});

test('a live snapshot is dated by the newest message, not by the poll', async (t) => {
  const { layer, clock } = await setup(snapshot());
  t.after(() => layer.destroy());
  clock.now = SERVER_NOW + 2000;
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, SERVER_NOW - 5000 + 2000);
});

test('feed problems are named; mixed feeds stay up and an unreachable one is an error', async (t) => {
  const { layer, responses } = await setup(
    snapshot({
      feeds: [
        feed(1, 'live', { heardAt: SERVER_NOW - 5000 }),
        feed(2, 'unreachable'),
      ],
    }),
  );
  t.after(() => layer.destroy());
  await layer.update();
  assert.equal(
    layer.getStats().loadingLabel,
    '1 vessel heard · feed 2 unreachable',
  );
  assert.equal(layerFeedState(layer.getStats()), 'nominal');
  responses.next = snapshot({
    feeds: [feed(1, 'unreachable')],
    records: [],
  });
  await layer.update();
  assert.equal(layer.getStats().error, 'feed 1 unreachable');
  assert.equal(layerFeedState(layer.getStats()), 'unavailable');
});

test('a failed request keeps unexpired vessels, reports the receiver unavailable and expires them', async (t) => {
  const { layer, clock, responses, draw } = await setup(snapshot());
  t.after(() => layer.destroy());
  await layer.update();
  responses.next = new Error('offline');
  clock.now = SERVER_NOW + 60_000;
  assert.equal(await layer.update(), false);
  assert.equal(layer.getStats().error, 'Local AIS receiver unavailable');
  assert.equal(markers(draw).items.size, 1);
  clock.now = SERVER_NOW + 700_000;
  await layer.update();
  assert.equal(markers(draw).items.size, 0);
  assert.equal(layer.getStats().count, 0);
});

test('a non-OK proxy reply is an unavailable receiver', async (t) => {
  const { layer } = await setup({ ok: false, body: {} });
  t.after(() => layer.destroy());
  assert.equal(await layer.update(), false);
  assert.equal(layer.getStats().error, 'Local AIS receiver unavailable');
});

test('records beyond ten minutes, off the globe or without a nine-digit MMSI are not drawn', async (t) => {
  const { layer, draw } = await setup(
    snapshot({
      records: [
        vessel(1),
        vessel(2, { lastSeenAt: SERVER_NOW - 601_000 }),
        vessel(3, { lat: 91 }),
        vessel(4, { mmsi: 'abc' }),
      ],
    }),
  );
  t.after(() => layer.destroy());
  await layer.update();
  assert.deepEqual([...markers(draw).items.keys()], ['local-ais:200000001']);
});

test('analyst records are bounded, shaped for the voice query and keep unknowns null', async (t) => {
  const { layer } = await setup(
    snapshot({
      records: [vessel(1, { speed: null, course: null, name: '' })],
    }),
  );
  t.after(() => layer.destroy());
  assert.deepEqual(
    layer.getAnalystRecords(),
    [],
    'nothing before the first poll',
  );
  await layer.update();
  const [row] = layer.getAnalystRecords();
  assert.deepEqual(row, {
    id: '200000001',
    mmsi: '200000001',
    name: null,
    lat: 30.5,
    lon: -40.5,
    speedKts: null,
    courseDeg: null,
    validated: true,
    approx: false,
    beaconType: null,
  });
  assert.equal(layer.getAnalystRecords(0).length, 0);
  layer.disable();
  assert.deepEqual(layer.getAnalystRecords(), []);
});

test('clicking a marker opens its card and an empty click closes it', async (t) => {
  let onClick;
  const entries = [];
  const picking = {
    registerPickOwner() {},
    unregisterPickOwner() {},
    resolvePickId: (hit) => hit,
    clickCard: () => false,
    isOwnedByOtherLayer: () => false,
  };
  const { layer } = await setup(snapshot(), {
    picking,
    pointer: { isPointerFree: () => true },
    input: () => ({
      onClick(fn) {
        onClick = fn;
        return () => {};
      },
    }),
    overlayHost: {
      setEntries: (source, list) => entries.push(list),
      setVisible() {},
    },
  });
  t.after(() => layer.destroy());
  await layer.update();
  onClick({ topHit: 'local-ais:200000001' });
  const card = entries.at(-1)[0];
  assert.equal(card.title, 'TEST 1');
  assert.ok(card.details.includes('MMSI: 200000001'));
  onClick({ topHit: null });
  assert.deepEqual(entries.at(-1), []);
});

test('analyst records withhold the position of an unvalidated or approximate fix', async (t) => {
  const { layer } = await setup(
    snapshot({
      records: [
        vessel(1),
        vessel(2, { validated: false }),
        vessel(3, { approx: true }),
        vessel(4, { validated: undefined }),
      ],
    }),
  );
  t.after(() => layer.destroy());
  await layer.update();
  const rows = Object.fromEntries(
    layer.getAnalystRecords().map((row) => [row.mmsi, row]),
  );
  assert.deepEqual(
    [rows['200000001'].lat, rows['200000001'].lon],
    [30.5, -40.5],
  );
  for (const mmsi of ['200000002', '200000003', '200000004']) {
    assert.equal(rows[mmsi].lat, null, `${mmsi} lat`);
    assert.equal(rows[mmsi].lon, null, `${mmsi} lon`);
    assert.equal(rows[mmsi].mmsi, mmsi, 'the vessel is still listed');
  }
  assert.deepEqual(
    [rows['200000002'].validated, rows['200000003'].approx],
    [false, true],
  );
});

test('a receiver whose every row was rejected reads as rejected data, not silence', async (t) => {
  const { layer } = await setup(
    snapshot({
      feeds: [feed(1, 'stale', { dropped: 4, rejected: 4 })],
      records: [],
    }),
  );
  t.after(() => layer.destroy());
  await layer.update();
  const stats = layer.getStats();
  assert.equal(stats.error, 'feed 1 rejected');
  assert.notEqual(stats.statusMessage, 'no recent messages');
  assert.equal(layerFeedState(stats), 'unavailable');
});

test('a quiet receiver with only old rows is STALE and carries a data age', async (t) => {
  const { layer, clock } = await setup(
    snapshot({
      feeds: [feed(1, 'stale', { dropped: 2, heardAt: SERVER_NOW - 700_000 })],
      records: [],
    }),
  );
  t.after(() => layer.destroy());
  clock.now = SERVER_NOW;
  await layer.update();
  const stats = layer.getStats();
  assert.equal(stats.status, 'stale');
  assert.equal(stats.error, undefined);
  assert.equal(stats.lastUpdate, SERVER_NOW - 700_000);
});

test('server and browser clocks that disagree are reconciled before the ten-minute expiry', async (t) => {
  // The server's clock runs 20 minutes behind the browser's. Without the
  // correction every vessel would look 20 minutes old and be thrown away.
  const skew = 20 * 60_000;
  const serverNow = SERVER_NOW - skew;
  const { layer, draw } = await setup(
    snapshot({
      generatedAt: serverNow,
      feeds: [feed(1, 'live', { heardAt: serverNow - 5000 })],
      records: [
        vessel(1, { lastSeenAt: serverNow - 5000 }),
        vessel(2, { lastSeenAt: serverNow - 601_000 }),
      ],
    }),
  );
  t.after(() => layer.destroy());
  await layer.update();
  assert.deepEqual([...markers(draw).items.keys()], ['local-ais:200000001']);
  // Dated on the browser's clock: 5 s before it, not 20 minutes.
  assert.equal(layer.getStats().lastUpdate, SERVER_NOW - 5000);
});

test('disabling the layer while a fetch is in flight discards the late answer', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const viewer = { scene: {} };
  const { draw } = bindFakeDraw(viewer);
  const layer = createLocalAisLayer({
    now: () => SERVER_NOW,
    fetchImpl: async (url, init) => {
      calls.push(url);
      await gate;
      if (init.signal.aborted) throw new DOMException('aborted', 'AbortError');
      return { ok: true, json: async () => snapshot() };
    },
    overlayHost: { setEntries() {}, setVisible() {} },
  });
  layer.init(viewer);
  layer.enable();
  t.after(() => layer.destroy());
  const pending = layer.update();
  layer.disable();
  release();
  assert.equal(await pending, false);
  assert.equal(markers(draw).show, false);
  assert.equal(markers(draw).items.size, 0);
  const stats = layer.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.error, undefined, 'an abandoned fetch is not a fault');
  assert.deepEqual(layer.getAnalystRecords(), []);
  assert.equal(await layer.update(), false);
  assert.equal(calls.length, 1, 'a disabled layer does not read again');
});

test('a beacon is drawn with its own marker and size, apart from vessels', async (t) => {
  const { layer, draw } = await setup(
    snapshot({ records: [vessel(1), beacon(1), beacon(2, 'mob')] }),
  );
  t.after(() => layer.destroy());
  await layer.update();
  const items = markers(draw).items;
  const ship = items.get('local-ais:200000001');
  const sart = items.get('local-ais:970000001');
  const mob = items.get('local-ais:970000002');
  assert.ok(ship && sart && mob, 'all three are drawn');
  assert.notEqual(sart.image, ship.image, 'a beacon is not a vessel marker');
  assert.equal(sart.image, mob.image);
  assert.deepEqual(ship.size, [22, 22]);
  assert.deepEqual(sart.size, [26, 26]);
});

test('clicking a beacon opens the beacon card, never a vessel card', async (t) => {
  let onClick;
  const entries = [];
  const { layer } = await setup(snapshot({ records: [beacon(1, 'epirb')] }), {
    picking: {
      registerPickOwner() {},
      unregisterPickOwner() {},
      resolvePickId: (hit) => hit,
      clickCard: () => false,
      isOwnedByOtherLayer: () => false,
    },
    pointer: { isPointerFree: () => true },
    input: () => ({
      onClick(fn) {
        onClick = fn;
        return () => {};
      },
    }),
    overlayHost: {
      setEntries: (source, list) => entries.push(list),
      setVisible() {},
    },
  });
  t.after(() => layer.destroy());
  await layer.update();
  onClick({ topHit: 'local-ais:970000001' });
  const card = entries.at(-1)[0];
  assert.equal(card.title, 'EPIRB beacon');
  assert.ok(card.details.includes('Active or test status: unknown'));
  assert.ok(!card.details.includes('Heard by your receiver'));
});

test('a receiver that heard only a beacon is heard, not "no recent messages"', async (t) => {
  const { layer } = await setup(snapshot({ records: [beacon(1)] }));
  t.after(() => layer.destroy());
  await layer.update();
  const stats = layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.loadingLabel, '1 feed live · 1 beacon heard');
  assert.equal(stats.statusMessage, undefined);
  assert.equal(layerFeedState(stats), 'nominal');
});

test('vessels and beacons are counted apart in the status', async (t) => {
  const { layer } = await setup(
    snapshot({ records: [vessel(1), vessel(2), beacon(1), beacon(2, 'mob')] }),
  );
  t.after(() => layer.destroy());
  await layer.update();
  assert.equal(
    layer.getStats().loadingLabel,
    '1 feed live · 2 vessels heard · 2 beacons heard',
  );
});

test('a beacon type the browser does not know is a vessel, not a beacon', async (t) => {
  const { layer, draw } = await setup(
    snapshot({
      records: [
        vessel(1, { beaconType: 'lifeboat' }),
        vessel(2, { beaconType: 7 }),
      ],
    }),
  );
  t.after(() => layer.destroy());
  await layer.update();
  assert.ok(layer.getAnalystRecords().every((row) => row.beaconType === null));
  const [first] = markers(draw).items.values();
  assert.deepEqual(first.size, [22, 22]);
});

test('analyst records carry the beacon kind and withhold a flagged beacon position like a vessel', async (t) => {
  const { layer } = await setup(
    snapshot({
      records: [
        beacon(1, 'sart'),
        beacon(2, 'mob', { validated: false }),
        beacon(3, 'epirb', { approx: true }),
        vessel(1),
      ],
    }),
  );
  t.after(() => layer.destroy());
  await layer.update();
  const rows = Object.fromEntries(
    layer.getAnalystRecords().map((row) => [row.mmsi, row]),
  );
  assert.equal(rows['970000001'].beaconType, 'sart');
  assert.deepEqual(
    [rows['970000001'].lat, rows['970000001'].lon],
    [30.5, -40.5],
  );
  for (const mmsi of ['970000002', '970000003']) {
    assert.equal(rows[mmsi].lat, null, mmsi);
    assert.equal(rows[mmsi].lon, null, mmsi);
    assert.ok(rows[mmsi].beaconType, 'still named as a beacon');
  }
  assert.equal(rows['200000001'].beaconType, null);
  assert.equal(layer.isPositionTrusted('970000001'), true);
  assert.equal(layer.isPositionTrusted('970000002'), false);
  assert.equal(layer.isPositionTrusted('local-ais:970000003'), false);
});

test('a feed whose newest row has aged out by the time the snapshot is read is not live', async (t) => {
  // The server read feed 1 when its only vessel was 599 s old; a slow second
  // read made the snapshot 2.5 s late, so the vessel is 601.5 s old by then.
  const generatedAt = SERVER_NOW + 2500;
  const { layer, clock } = await setup(
    snapshot({
      generatedAt,
      feeds: [
        feed(1, 'live', {
          count: 1,
          heardAt: SERVER_NOW - 599_000,
          newestAt: SERVER_NOW - 599_000,
          rejected: 3,
        }),
        feed(2, 'live', {
          count: 1,
          heardAt: SERVER_NOW - 5000,
          newestAt: SERVER_NOW - 5000,
        }),
      ],
      records: [vessel(2, { lastSeenAt: SERVER_NOW - 5000 })],
    }),
  );
  t.after(() => layer.destroy());
  clock.now = generatedAt;
  await layer.update();
  const stats = layer.getStats();
  assert.equal(stats.status, 'streaming');
  assert.equal(
    stats.loadingLabel,
    '1 vessel heard · feed 1 stale',
    'never "2 feeds live" while one of them has nothing left',
  );
  // A demoted feed is quiet, not rejecting, whatever the server counted.
  assert.doesNotMatch(String(stats.loadingLabel), /rejected/);
});

test('a feed whose newest row is exactly ten minutes old is still live, one millisecond later it is not', async () => {
  const label = async (age) => {
    const { layer } = await setup(
      snapshot({
        feeds: [feed(1, 'live', { newestAt: SERVER_NOW - age })],
        records: [vessel(1, { lastSeenAt: SERVER_NOW - age })],
      }),
    );
    await layer.update();
    const text = layer.getStats().loadingLabel;
    layer.destroy();
    return text;
  };
  assert.equal(await label(600_000), '1 feed live · 1 vessel heard');
  assert.notEqual(await label(600_001), '1 feed live · 1 vessel heard');
});

test('a live feed still inside the window beside a fresh one stays live', async (t) => {
  const { layer } = await setup(
    snapshot({
      feeds: [
        feed(1, 'live', { newestAt: SERVER_NOW - 599_000 }),
        feed(2, 'live', { newestAt: SERVER_NOW - 5000 }),
      ],
      records: [vessel(1, { lastSeenAt: SERVER_NOW - 599_000 }), vessel(2)],
    }),
  );
  t.after(() => layer.destroy());
  await layer.update();
  assert.equal(layer.getStats().loadingLabel, '2 feeds live · 2 vessels heard');
});

test('a live feed that reports no newest row at all is not live', async (t) => {
  const { layer } = await setup(
    snapshot({
      feeds: [
        feed(1, 'live', { newestAt: null }),
        feed(2, 'live', { newestAt: SERVER_NOW - 5000 }),
      ],
      records: [vessel(2)],
    }),
  );
  t.after(() => layer.destroy());
  await layer.update();
  assert.equal(layer.getStats().loadingLabel, '1 vessel heard · feed 1 stale');
});

test('a receiver that holds only an old refused row is STALE with its age, not "never"', async (t) => {
  // The server dates a feed by every row it heard, refused ones included.
  const heardAt = SERVER_NOW - 3_000_000;
  const { layer } = await setup(
    snapshot({
      feeds: [feed(1, 'stale', { dropped: 1, rejected: 0, heardAt })],
      records: [],
    }),
  );
  t.after(() => layer.destroy());
  await layer.update();
  const stats = layer.getStats();
  assert.equal(stats.status, 'stale');
  assert.equal(stats.statusMessage, 'no recent messages');
  assert.equal(stats.lastUpdate, heardAt);
});
