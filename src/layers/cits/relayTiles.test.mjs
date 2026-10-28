import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CITS_MAX_TILES,
  citsLanePointToLonLat,
  citsTilesForBounds,
  compactCitsIntersections,
  compactCitsState,
  createCitsTileStore,
} from '../../../server/providers/cits/tiles.js';

const NOW = Date.parse('2026-10-05T08:00:00.000Z');
const box = { west: 15.4, south: 47.0, east: 15.5, north: 47.1 };
const point = (id, kind, lon, lat, extra = {}) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: {
    mac: id,
    kind,
    lastSeen: new Date(NOW - 1_000).toISOString(),
    ...extra,
  },
});

test('tile cover picks the most detailed zoom with at most four tiles', () => {
  const graz = citsTilesForBounds({
    west: 15.42,
    south: 47.06,
    east: 15.45,
    north: 47.08,
  });
  assert.ok(graz.tiles.length <= CITS_MAX_TILES);
  assert.equal(graz.zoom, 13);
  assert.deepEqual(graz.tiles, [
    '13/4446/2878',
    '13/4446/2879',
    '13/4447/2878',
    '13/4447/2879',
  ]);
  assert.equal(
    citsTilesForBounds({ west: 5, south: 45, east: 17, north: 55 }),
    null,
    'country-sized views are refused instead of subscribed',
  );
  assert.equal(citsTilesForBounds({ west: 'x' }), null);
});

test('deltas patch, upsert and remove points; a sequence gap asks for resync', () => {
  const store = createCitsTileStore();
  store.applyFullStatus({
    type: 'tile-fullstatus',
    tile: '13/1/1',
    seq: 1,
    state: {
      points: { a: point('a', 'tram', 15.43, 47.07, { speedKmh: 10 }) },
      tracks: {},
      trafficLightMaps: {},
    },
  });
  const resync = store.applyDeltaBatch({
    type: 'tile-delta-batch',
    deltas: [
      {
        tile: '13/1/1',
        baseSeq: 1,
        seq: 2,
        upsertPointIds: ['b'],
        patchPointIds: ['a'],
        removePoints: [],
      },
    ],
    pointsById: { b: point('b', 'bus', 15.44, 47.07) },
    pointPatchesById: {
      a: {
        id: 'a',
        geometry: { type: 'Point', coordinates: [15.431, 47.071] },
        properties: { speedKmh: 25 },
      },
    },
  });
  assert.deepEqual(resync, []);
  const merged = store.merged();
  assert.equal(merged.points.size, 2);
  assert.equal(merged.points.get('a').properties.speedKmh, 25);
  assert.deepEqual(
    merged.points.get('a').geometry.coordinates,
    [15.431, 47.071],
  );

  const gap = store.applyDeltaBatch({
    type: 'tile-delta-batch',
    deltas: [{ tile: '13/1/1', baseSeq: 7, seq: 8 }],
  });
  assert.deepEqual(gap, ['13/1/1']);
  assert.equal(store.has('13/1/1'), false);
});

test('compaction drops silent vehicles, keeps fixed stations and dedupes hazards', () => {
  const stale = new Date(NOW - 10 * 60_000).toISOString();
  const denm = {
    eventPosition: [15.45, 47.05],
    traces: [
      [
        [15.45, 47.05],
        [15.46, 47.06],
      ],
    ],
    messageKind: 'roadworks',
    messageLabel: 'Roadworks',
    originatingStationId: 1,
    sequenceNumber: 3,
    speedLimit: 60,
  };
  const merged = {
    points: new Map([
      ['car', point('car', 'car', 15.42, 47.05, { lastSeen: stale })],
      [
        'light',
        point('light', 'traffic_light', 15.43, 47.05, {
          lastSeen: stale,
          trafficLightSpatTs: new Date(NOW - 2_000).toISOString(),
          trafficLightSpat: { groups: [{ signalGroup: 1, eventState: 6 }] },
        }),
      ],
      [
        'rsu1',
        point('rsu1', 'rsu', 15.44, 47.05, {
          stationId: 1,
          denmData: denm,
        }),
      ],
      [
        'rsu2',
        point('rsu2', 'rsu', 15.44, 47.06, {
          stationId: 1,
          denmEvents: [{ key: 'seq:3', denmData: denm }],
        }),
      ],
      ['far', point('far', 'bus', 16.4, 48.2)],
    ]),
    tracks: new Map(),
  };
  const { objects, hazards } = compactCitsState(merged, box, { now: NOW });
  assert.deepEqual(objects.map((o) => o.id).sort(), ['light', 'rsu1', 'rsu2']);
  assert.deepEqual(objects.find((o) => o.id === 'light').spat, [
    { group: '1', state: 6 },
  ]);
  assert.equal(hazards.length, 1);
  assert.equal(hazards[0].speedLimit, 60);
});

test('MAPEM lanes convert centimetre offsets around the reference point', () => {
  const [lon, lat] = citsLanePointToLonLat({ lon: 15, lat: 47 }, [0, 11132]);
  assert.equal(lon, 15);
  assert.ok(Math.abs(lat - 47.001) < 1e-9);
  const [intersection] = compactCitsIntersections(
    {
      maps: new Map([
        [
          'light',
          {
            mac: 'light',
            map: {
              name: 'Test',
              refLat: 47.05,
              refLon: 15.45,
              lanes: [
                {
                  laneId: '1',
                  kind: 'vehicle',
                  ingressPath: true,
                  signalGroups: ['2'],
                  points: [
                    [0, 0],
                    [500, 0],
                  ],
                },
              ],
            },
          },
        ],
      ]),
    },
    box,
  );
  assert.equal(intersection.name, 'Test');
  assert.deepEqual(intersection.lanes[0].signalGroups, ['2']);
  assert.equal(intersection.lanes[0].coordinates.length, 2);
});

test('two views sharing the tiled relay both get their tiles', async () => {
  const { createCitsRelay } = await import('../../../server/providers/cits.js');
  const sockets = [];
  class FakeSocket {
    constructor() {
      this.sent = [];
      sockets.push(this);
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    close() {}
  }
  const relay = createCitsRelay({ WebSocketImpl: FakeSocket });
  try {
    const a = ['13/1/1'];
    const b = ['13/9/9'];
    relay.demand(a);
    const socket = sockets[0];
    socket.onopen();
    relay.demand(b);
    relay.demand(a);
    const subscribed = new Set();
    for (const message of socket.sent) {
      if (message.type === 'subscribe-tiles')
        for (const tile of message.tiles) subscribed.add(tile);
      if (message.type === 'unsubscribe-tiles')
        for (const tile of message.tiles) subscribed.delete(tile);
    }
    assert.deepEqual([...subscribed].sort(), ['13/1/1', '13/9/9']);
    for (const tile of [...a, ...b])
      await socket.onmessage({
        data: JSON.stringify({
          type: 'tile-fullstatus',
          tile,
          seq: 1,
          state: { points: {}, tracks: {}, trafficLightMaps: {} },
        }),
      });
    assert.equal(relay.ready(a), true);
    assert.equal(relay.ready(b), true);
  } finally {
    relay.dispose();
  }
});

test('private vehicles are reduced to anonymous dots without tracks', async () => {
  const { compactCitsState, citsAnonymousId } =
    await import('../../../server/providers/cits/tiles.js');
  const merged = {
    points: new Map([
      [
        '52:36:be:90:ac:ba',
        point('52:36:be:90:ac:ba', 'car', 15.42, 47.05, {
          speedKmh: 48,
          headingDeg: 235,
          vehicleLengthM: 4.6,
          stationId: 3197152442,
        }),
      ],
      [
        'tram',
        point('tram', 'tram', 15.43, 47.05, {
          transitLineDisplay: '6',
          transitTargetName: 'St. Peter',
          vehicleNumber: '217',
        }),
      ],
    ]),
  };
  const state = compactCitsState(merged, box, { now: NOW });
  assert.equal(Object.hasOwn(state, 'tracks'), false);
  const car = state.objects.find((o) => o.kind === 'car');
  assert.deepEqual(Object.keys(car).sort(), [
    'anonymous',
    'id',
    'kind',
    'lastSeen',
    'lat',
    'lon',
    'speedKmh',
    'stale',
  ]);
  assert.match(car.id, /^anon-[0-9a-f]{16}$/);
  assert.notEqual(car.id, citsAnonymousId('52:36:be:90:ac:ba'));
  assert.doesNotMatch(JSON.stringify(state), /52:36:be|3197152442/);
  const tram = state.objects.find((o) => o.kind === 'tram');
  assert.equal(tram.line, '6');
  assert.equal(tram.anonymous, undefined);
});

test('anonymous ids are new in every response and their order is random', async () => {
  const { compactCitsState } =
    await import('../../../server/providers/cits/tiles.js');
  const cars = Array.from({ length: 12 }, (_, index) => [
    `car-${index}`,
    point(`car-${index}`, 'car', 15.41 + index * 0.005, 47.05),
  ]);
  const merged = { points: new Map(cars) };
  const ids = new Set();
  const orders = new Set();
  for (let poll = 0; poll < 8; poll++) {
    const { objects } = compactCitsState(merged, box, { now: NOW });
    assert.equal(objects.length, 12);
    for (const object of objects) ids.add(object.id);
    orders.add(objects.map((object) => object.lon).join(','));
  }
  // The same twelve cars, polled eight times: no id comes back.
  assert.equal(ids.size, 12 * 8);
  assert.ok(orders.size > 1, 'the list order changes between responses');
});

test('hazards come from public stations only, never from a private car', async () => {
  const { compactCitsState } =
    await import('../../../server/providers/cits/tiles.js');
  const denm = (originatingStationId, lon) => ({
    eventPosition: [lon, 47.05],
    messageKind: 'traffic_condition',
    messageLabel: 'Stationary vehicle',
    originatingStationId,
    sequenceNumber: 1,
  });
  const merged = {
    points: new Map([
      [
        'car',
        point('car', 'car', 15.42, 47.05, {
          stationId: 77,
          denmData: denm(77, 15.42),
        }),
      ],
      [
        'rsu',
        point('rsu', 'rsu', 15.44, 47.05, {
          stationId: 5,
          // A roadside unit re-broadcasting the car's warning, plus its own.
          denmEvents: [
            { key: 'relay', denmData: denm(77, 15.42) },
            { key: 'own', denmData: denm(5, 15.45) },
          ],
        }),
      ],
    ]),
  };
  const { hazards } = compactCitsState(merged, box, { now: NOW });
  assert.equal(hazards.length, 1);
  assert.deepEqual(hazards[0].position, [15.45, 47.05]);
});

test('a re-broadcast DENM is dropped when its originator is not a known public station', async () => {
  const { compactCitsState } =
    await import('../../../server/providers/cits/tiles.js');
  const denm = (originatingStationId, lon) => ({
    eventPosition: [lon, 47.05],
    messageKind: 'traffic_condition',
    messageLabel: 'Stationary vehicle',
    originatingStationId,
    sequenceNumber: 1,
  });
  const merged = {
    points: new Map([
      [
        'rsu',
        point('rsu', 'rsu', 15.44, 47.05, {
          stationId: 5,
          denmEvents: [
            // The originating car has already left the mirror.
            { key: 'gone', denmData: denm(77, 15.42) },
            { key: 'trailer', denmData: denm(6, 15.46) },
            { key: 'own', denmData: { ...denm(null, 15.45) } },
          ],
        }),
      ],
      ['trailer', point('trailer', 'trailer', 15.46, 47.05, { stationId: 6 })],
    ]),
  };
  const { hazards } = compactCitsState(merged, box, { now: NOW });
  assert.deepEqual(
    hazards.map((hazard) => hazard.position[0]).sort(),
    [15.45, 15.46],
  );
});

test('station kinds match case-insensitively; unknown kinds stay anonymous', async () => {
  const { compactCitsState, citsNormalizeKind } =
    await import('../../../server/providers/cits/tiles.js');
  assert.equal(citsNormalizeKind('Bus'), 'bus');
  assert.equal(citsNormalizeKind(' TRAM '), 'tram');
  assert.equal(citsNormalizeKind('Heavy-Truck'), 'heavy_truck');
  assert.equal(citsNormalizeKind(undefined), 'unknown');
  const merged = {
    points: new Map([
      ['bus', point('bus', 'Bus', 15.41, 47.05, { transitLineDisplay: '31' })],
      ['tram', point('tram', 'TRAM', 15.42, 47.05)],
      ['truck', point('truck', 'truck', 15.43, 47.05)],
      ['emergency', point('emergency', 'emergency', 15.44, 47.05)],
      ['none', point('none', undefined, 15.45, 47.05)],
    ]),
  };
  const { objects } = compactCitsState(merged, box, { now: NOW });
  const byKind = Object.fromEntries(objects.map((o) => [o.kind, o]));
  assert.equal(byKind.bus.id, 'bus');
  assert.equal(byKind.bus.line, '31');
  assert.equal(byKind.tram.id, 'tram');
  for (const kind of ['truck', 'emergency', 'unknown'])
    assert.equal(byKind[kind].anonymous, true, kind);
});

test('the tile mirror keeps track ids only, never coordinates', () => {
  const store = createCitsTileStore();
  store.applyFullStatus({
    type: 'tile-fullstatus',
    tile: '13/1/1',
    seq: 1,
    state: {
      points: {},
      tracks: {
        't-track': {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [15, 47],
              [15.1, 47.1],
            ],
          },
        },
      },
      trafficLightMaps: {},
    },
  });
  const ok = store.applyDeltaBatch({
    type: 'tile-delta-batch',
    deltas: [
      { tile: '13/1/1', baseSeq: 1, seq: 2, patchTrackIds: ['t-track'] },
    ],
    trackPatchesById: {
      't-track': { id: 't-track', appendCoordinates: [[15.2, 47.2]] },
    },
  });
  assert.deepEqual(ok, []);
  assert.equal(Object.hasOwn(store.merged(), 'tracks'), false);
});

test('the full stream answers 403 until the operator opts in', async () => {
  const { createCitsMiddleware, citsFullStreamEnabled } =
    await import('../../../server/providers/cits.js');
  assert.equal(citsFullStreamEnabled({}), false);
  assert.equal(citsFullStreamEnabled({ CITS_OTM_FULL_STREAM: '1' }), true);
  const previous = process.env.CITS_OTM_FULL_STREAM;
  delete process.env.CITS_OTM_FULL_STREAM;
  try {
    const middleware = createCitsMiddleware({ tiled: null, full: null });
    const response = await new Promise((resolve) => {
      const res = {
        writeHead(status) {
          this.status = status;
        },
        end(body) {
          resolve({ status: this.status, body: JSON.parse(body) });
        },
      };
      middleware(
        {
          method: 'GET',
          url: `/state?west=15&south=47&east=16&north=48&mode=full`,
        },
        res,
      );
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.fullStream, false);
  } finally {
    if (previous !== undefined) process.env.CITS_OTM_FULL_STREAM = previous;
  }
});

test('oversized upstream frames are refused before parsing', async () => {
  const { gzipSync } = await import('node:zlib');
  const { decodeCitsFrame } = await import('../../../server/providers/cits.js');
  assert.deepEqual(
    await decodeCitsFrame(gzipSync(Buffer.from('{"type":"hello"}'))),
    { type: 'hello' },
  );
  const bomb = gzipSync(Buffer.alloc(100 * 1024 * 1024, 32));
  await assert.rejects(decodeCitsFrame(bomb));
});
