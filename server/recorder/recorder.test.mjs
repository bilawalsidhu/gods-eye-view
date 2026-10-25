import test from 'node:test';
import assert from 'node:assert/strict';
import { createThinner } from './thin.js';
import { aircraftPoints, militaryPoints, vesselPoints } from './extract.js';
import { createRecorder } from './recorder.js';

const pt = (o) => ({
  id: 'a',
  layer: 'air',
  lat: 10,
  lon: 10,
  alt: null,
  heading: 90,
  speed: 100,
  ts: 1000,
  ...o,
});

test('thinner keeps the first point and drops quick or tiny moves', () => {
  const keep = createThinner();
  assert.equal(keep(pt()), true);
  assert.equal(keep(pt({ ts: 1010, lat: 11 })), false, 'too soon');
  assert.equal(keep(pt({ ts: 1060 })), false, 'did not move');
  assert.equal(keep(pt({ ts: 1060, lat: 10.01 })), true, 'moved');
  assert.equal(
    keep(pt({ ts: 1100, lat: 10.01, heading: 200 })),
    true,
    'turned',
  );
});

test('extractors read each feed shape and skip rows without a position', () => {
  const states = [
    ['abc123', 'X', 'c', 5, 0, 8.5, 47.5, 100, false, 200, 270, 0, null, 120],
  ];
  assert.deepEqual(aircraftPoints({ states }, 1)[0], {
    name: 'X',
    id: 'abc123',
    layer: 'air',
    lat: 47.5,
    lon: 8.5,
    alt: 120,
    heading: 270,
    speed: 200,
    ts: 5,
  });
  assert.equal(aircraftPoints({ states: [['nopos']] }, 1).length, 0);
  const [m] = militaryPoints(
    { ac: [{ hex: 'ae1', lat: 1, lon: 2, alt_baro: 1000, gs: 100, track: 5 }] },
    7,
  );
  assert.equal(m.layer, 'mil');
  assert.ok(Math.abs(m.alt - 304.8) < 0.01);
  const rows = [{ mmsi: '123456789', lat: 1, lon: 2, speed: 3, course: 4 }];
  assert.equal(vesselPoints(rows, 9)[0].heading, 4);
});

test('recorder stores, queries and purges', () => {
  const now = 2_000_000_000_000;
  const rec = createRecorder({
    file: ':memory:',
    retentionDays: 1,
    now: () => now,
  });
  rec.ingestMany([
    pt({ ts: 100 }),
    pt({ id: 'b', layer: 'vessel', ts: 200, lat: 50, lon: 5 }),
  ]);
  rec.flush();
  assert.deepEqual(
    { ...rec.store.range() },
    {
      from_ts: 100,
      to_ts: 200,
      count: 2,
    },
  );
  assert.equal(rec.store.track('a', 0, 500).length, 1);
  const w = rec.store.window({
    from: 0,
    to: 500,
    bbox: { west: 0, south: 40, east: 10, north: 60 },
    layers: ['vessel'],
  });
  assert.deepEqual(
    w.map((p) => p.id),
    ['b'],
  );
  assert.equal(rec.store.purgeBefore(150), 1);
  rec.close();
});

test('at() returns the latest position per contact before the time', () => {
  const rec = createRecorder({ file: ':memory:', retentionDays: 0 });
  rec.ingestMany([
    pt({ ts: 100, lat: 1 }),
    pt({ ts: 200, lat: 2 }),
    pt({ ts: 400, lat: 3 }),
  ]);
  rec.flush();
  const at = rec.store.at({ time: 300, lookback: 600 });
  assert.deepEqual(
    at.map((p) => p.lat),
    [2],
  );
  assert.equal(rec.store.at({ time: 300, lookback: 50 }).length, 0);
  rec.close();
});

test('history tools call the recorder API and cap rows', async () => {
  const { historyTools } = await import('./tools.js');
  const calls = [];
  const services = {
    app: {
      fetch: async (url) => {
        calls.push(url);
        return Response.json({ points: [pt({ ts: 100 }), pt({ ts: 200 })] });
      },
    },
  };
  const replay = historyTools.find((t) => t.name === 'replay_to');
  const out = await replay.run(
    { time: '2026-10-25T14:00:00Z', layers: ['air'], limit: 1 },
    { services },
  );
  assert.match(calls[0], /^\/api\/history\/at\?to=\d+&layers=air$/);
  assert.equal(out.data.returned, 1);
  assert.equal(out.data.total, 2);
  const track = historyTools.find((t) => t.name === 'history_track');
  await track.run(
    { id: 'abc', from: '2026-10-25T00:00:00Z', to: '2026-10-25T01:00:00Z' },
    { services },
  );
  assert.match(calls[1], /^\/api\/history\/track\/abc\?from=/);
  const dead = {
    app: { fetch: async () => new Response('', { status: 404 }) },
  };
  await assert.rejects(
    replay.run({ time: '2026-10-25T14:00:00Z' }, { services: dead }),
    /GEV_RECORDER=1/,
  );
});

test('local receiver records become positions on the local layer', async () => {
  const { localReceiverPoints } = await import('./extract.js');
  const body = {
    records: [
      {
        icao: 'abc123',
        lat: 1,
        lon: 2,
        altitudeFt: 1000,
        groundSpeedKt: 100,
        trackDeg: 90,
        lastPositionAt: 5000,
      },
      { icao: 'nopos', lat: null, lon: null },
    ],
  };
  const [p] = localReceiverPoints(body, 9);
  assert.equal(localReceiverPoints(body, 9).length, 1);
  assert.equal(p.layer, 'local');
  assert.equal(p.ts, 5);
  assert.ok(Math.abs(p.alt - 304.8) < 0.01);
});

test('fences report enter and exit, honour layers and ignore older positions', async () => {
  const { insideFence, cleanFence } = await import('./fences.js');
  assert.equal(
    insideFence(
      { west: 170, east: -170, south: -5, north: 5 },
      { lat: 0, lon: 175 },
    ),
    true,
  );
  assert.equal(
    insideFence(
      { west: 170, east: -170, south: -5, north: 5 },
      { lat: 0, lon: 0 },
    ),
    false,
  );
  assert.throws(
    () => cleanFence({ name: 'x', west: 0, south: 5, east: 1, north: 1 }),
    /south/,
  );
  assert.throws(
    () => cleanFence({ west: 0, south: 0, east: 1, north: 1 }),
    /name/,
  );

  const rec = createRecorder({
    file: ':memory:',
    retentionDays: 0,
    now: () => 1000 * 1000,
  });
  const id = await rec.addFence({
    name: 'Box',
    west: 0,
    south: 0,
    east: 10,
    north: 10,
    layers: ['air'],
  });
  rec.ingestMany([
    pt({ ts: 500, lat: 5, lon: 5 }), // before the fence existed
    pt({ ts: 1001, lat: 5, lon: 5 }), // enter
    pt({ ts: 1002, lat: 6, lon: 6 }), // still inside
    pt({ ts: 1003, lat: 50, lon: 50 }), // exit
    pt({ id: 'v', layer: 'vessel', ts: 1004, lat: 5, lon: 5 }), // wrong layer
  ]);
  rec.flush();
  const events = rec.store.events({ fenceId: id });
  assert.deepEqual(events.map((e) => e.kind).reverse(), ['enter', 'exit']);
  assert.equal(events[0].fence, 'Box');
  assert.equal(await rec.removeFence(id), 1);
  rec.close();
});

test('geofence tools call the history API', async () => {
  const { historyTools } = await import('./tools.js');
  const calls = [];
  const services = {
    app: {
      fetch: async (url, init) => {
        calls.push([url, init.method]);
        return Response.json(
          init.method === 'POST'
            ? { id: 3 }
            : {
                fences: [],
                events: [
                  {
                    ts: 100,
                    fence: 'Box',
                    fence_id: 3,
                    id: 'a',
                    layer: 'air',
                    kind: 'enter',
                    lat: 1,
                    lon: 2,
                  },
                ],
              },
        );
      },
    },
  };
  const tool = (name) => historyTools.find((t) => t.name === name);
  const add = await tool('geofence_add').run(
    { name: 'Box', bbox: { west: 0, south: 0, east: 1, north: 1 } },
    { services },
  );
  assert.equal(add.data.id, 3);
  assert.deepEqual(calls[0], ['/api/history/fences', 'POST']);
  const events = await tool('geofence_events').run({}, { services });
  assert.equal(events.data.rows[0].kind, 'enter');
  await tool('geofence_remove').run({ id: 3 }, { services });
  assert.deepEqual(calls.at(-1), ['/api/history/fences/3', 'DELETE']);
});
