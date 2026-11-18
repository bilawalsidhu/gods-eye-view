import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createRailService } from '../sources/railService.js';
import { railEnabledFeeds } from '../data/railFeeds.js';

import {
  RAIL_PATH_PACK_MAX_BYTES,
  railAdmissionGlobalMax,
  railNaturalRequestsPerMinute,
} from '../data/railProxy.js';
import {
  createFsPathPackReader,
  createFsSchedulePackReader,
  createRailPackCache,
  sendRailResponse,
} from '../../server/providers/rail.js';

const request = (path, method = 'GET') => ({
  url: `https://example.test${path}`,
  method,
});

/** A full-dataset FeedMessage with one commuter train and one bus. */
function mbtaBytes() {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  header.writeVarintField(3, Math.floor(Date.now() / 1000));
  writer.writeBytesField(1, header.finish());
  for (const [id, route] of [
    ['cr', 'CR-Providence'],
    ['bus', '1'],
  ]) {
    const entity = new PbfWriter();
    entity.writeStringField(1, id);
    const vehicle = new PbfWriter();
    const trip = new PbfWriter();
    trip.writeStringField(5, route);
    vehicle.writeBytesField(1, trip.finish());
    const position = new PbfWriter();
    position.writeFloatField(1, 42.3);
    position.writeFloatField(2, -71.1);
    vehicle.writeBytesField(2, position.finish());
    const descriptor = new PbfWriter();
    descriptor.writeStringField(1, id);
    vehicle.writeBytesField(8, descriptor.finish());
    entity.writeBytesField(4, vehicle.finish());
    writer.writeBytesField(2, entity.finish());
  }
  return writer.finish();
}

test('the service confines requests to registered feeds and GET', async (t) => {
  let calls = 0;
  const service = createRailService({
    fetchImpl: async () => {
      calls++;
      throw new Error('unexpected');
    },
  });
  t.after(service.close);
  for (const path of [
    '/other',
    '/api/rail/trains/unknown',
    '/api/rail/trains/vre',
    '/api/rail/trains/https%3A%2F%2Fexample.test',
    '/api/rail/vehicles/mbta-rail',
  ]) {
    assert.equal((await service.handle(request(path))).status, 404, path);
  }
  for (const method of ['POST', 'HEAD']) {
    const refused = await service.handle(request('/api/rail/feeds', method));
    assert.equal(refused.status, 405);
    // A refusal is never kept by a shared cache.
    assert.equal(refused.headers.get('cache-control'), 'no-store');
    assert.equal(refused.headers.get('allow'), 'GET');
  }
  const response = await service.handle(request('/api/rail/feeds'));
  assert.equal(response.status, 200);
  const { feeds } = await response.json();
  assert.ok(feeds.some((feed) => feed.id === 'mbta-rail'));
  assert.ok(feeds.every((feed) => feed.url === undefined));
  assert.equal(calls, 0);
  service.close();
  assert.equal((await service.handle(request('/api/rail/feeds'))).status, 503);
});

test('a snapshot carries trains only and is served from cache while fresh', async (t) => {
  const urls = [];
  const service = createRailService({
    fetchImpl: async (url, init) => {
      urls.push(url);
      assert.equal(init.redirect, 'manual');
      assert.match(init.headers['User-Agent'], /rail-proxy/);
      return new Response(mbtaBytes(), { status: 200 });
    },
  });
  t.after(service.close);
  const first = await service.handle(request('/api/rail/trains/mbta-rail'));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-GEV-Cache'), 'MISS');
  const body = await first.json();
  assert.equal(body.count, 1);
  assert.equal(body.dropped, 1);
  assert.equal(body.trains[0].category, 'local');
  const second = await service.handle(request('/api/rail/trains/mbta-rail'));
  assert.equal(second.headers.get('X-GEV-Cache'), 'HIT');
  assert.deepEqual(urls, ['https://cdn.mbta.com/realtime/VehiclePositions.pb']);
});

test('a redirect off the feed origin is refused before it is followed', async (t) => {
  const urls = [];
  const service = createRailService({
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(null, {
        status: 307,
        headers: { location: 'https://elsewhere.test/feed.pb' },
      });
    },
  });
  t.after(service.close);
  const response = await service.handle(request('/api/rail/trains/mbta-rail'));
  assert.equal(response.status, 504);
  assert.equal((await response.json()).feedId, 'mbta-rail');
  assert.ok(Number(response.headers.get('Retry-After')) >= 1);
  assert.deepEqual(urls, ['https://cdn.mbta.com/realtime/VehiclePositions.pb']);
  // The cooldown answers the next request without contacting the operator.
  const again = await service.handle(request('/api/rail/trains/mbta-rail'));
  assert.equal(again.status, 503);
  assert.equal(again.headers.get('X-Rail-Backoff'), 'cooldown');
  assert.equal(urls.length, 1);
});

test('one document for positions and trip updates is fetched once per window', async (t) => {
  let now = 1_800_000_000_000;
  const urls = [];
  const service = createRailService({
    now: () => now,
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(mbtaBytes(), { status: 200 });
    },
  });
  t.after(service.close);
  const trains = '/api/rail/trains/mta-lirr';
  const updates = '/api/rail/updates/mta-lirr';
  // Both at once share one request; each route keeps its own snapshot.
  const [a, b] = await Promise.all([
    service.handle(request(trains)),
    service.handle(request(updates)),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(urls.length, 1);
  // Positions come round again (15 s); trip updates (30 s) read that body.
  now += 16_000;
  await service.handle(request(trains));
  assert.equal(urls.length, 2);
  now += 15_000;
  assert.equal((await service.handle(request(updates))).status, 200);
  assert.equal(urls.length, 2, 'the body positions fetched 15 s ago');
  // With nobody reading positions, trip updates fetch on their own window.
  now += 31_000;
  await service.handle(request(updates));
  assert.equal(urls.length, 3);
  assert.equal(new Set(urls).size, 1, 'the same URL each time');
});

test('an upstream HTTP error answers 502 with a retry hint', async (t) => {
  const service = createRailService({
    fetchImpl: async () => new Response('nope', { status: 500 }),
  });
  t.after(service.close);
  const response = await service.handle(request('/api/rail/trains/mta-lirr'));
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, 'Rail feed unavailable');
  assert.ok(body.retryInSec >= 1);
});

test('path packs are served from the injected reader for enabled feeds', async (t) => {
  const asked = [];
  const pack = JSON.stringify({ version: 1, feedId: 'mta-lirr' });
  const service = createRailService({
    fetchImpl: async () => {
      throw new Error('a path request never reaches an operator');
    },
    readPathPack: async (feedId, options) => {
      asked.push([feedId, options.maxBytes]);
      return feedId === 'mta-lirr' ? pack : null;
    },
  });
  t.after(service.close);
  const response = await service.handle(request('/api/rail/paths/mta-lirr'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(await response.text(), pack);
  assert.deepEqual(asked, [['mta-lirr', RAIL_PATH_PACK_MAX_BYTES]]);
  const none = await service.handle(request('/api/rail/paths/mbta-rail'));
  assert.equal(none.status, 404);
  assert.equal(none.headers.get('cache-control'), 'no-store');
  for (const blocked of [
    '/api/rail/paths/vre',
    '/api/rail/paths/unknown',
    '/api/rail/paths/..%2Fsecret',
  ])
    assert.equal((await service.handle(request(blocked))).status, 404, blocked);
  assert.equal(asked.length, 2, 'unregistered ids never reach the reader');
  assert.equal(
    (await service.handle(request('/api/rail/paths/mta-lirr', 'POST'))).status,
    405,
  );
});

test('a missing reader or pack is a 404; an unreadable or oversized pack is a 503', async (t) => {
  const bare = createRailService();
  t.after(bare.close);
  assert.equal(
    (await bare.handle(request('/api/rail/paths/mta-lirr'))).status,
    404,
  );
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = warn;
  });
  const failing = createRailService({
    readPathPack: async () => {
      throw new Error('disk on fire');
    },
  });
  t.after(failing.close);
  // A reader that fails (EMFILE, EACCES, EIO) is not "no pack": asked again.
  for (const [kind, error] of [
    ['paths', 'Rail paths unreadable'],
    ['schedule', 'Rail schedule unreadable'],
  ]) {
    const unreadable = createRailService({
      [kind === 'paths' ? 'readPathPack' : 'readSchedulePack']: async () => {
        const fault = new Error('too many open files');
        fault.code = 'EMFILE';
        throw fault;
      },
    });
    t.after(unreadable.close);
    const response = await unreadable.handle(
      request(`/api/rail/${kind}/mta-lirr`),
    );
    assert.equal(response.status, 503, kind);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(Number(response.headers.get('Retry-After')) > 0);
    assert.equal((await response.json()).error, error);
  }
  assert.equal(
    (await failing.handle(request('/api/rail/paths/mta-lirr'))).status,
    503,
  );
  const none = createRailService({ readPathPack: async () => null });
  t.after(none.close);
  assert.equal(
    (await none.handle(request('/api/rail/paths/mta-lirr'))).status,
    404,
  );
  // Over the cap is a build fault, not an unbuilt pack: its own answer,
  // whether the service measures it or the reader refuses it unread.
  for (const readPathPack of [
    async () => new Uint8Array(RAIL_PATH_PACK_MAX_BYTES + 1),
    async () => {
      const error = new Error('pack is 30000000 bytes');
      error.code = 'PACK_TOO_LARGE';
      throw error;
    },
  ]) {
    const huge = createRailService({ readPathPack });
    t.after(huge.close);
    const response = await huge.handle(request('/api/rail/paths/mta-lirr'));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).error, 'Rail paths too large');
  }
  // At the cap is served, as bytes.
  const full = createRailService({
    readPathPack: async () => new Uint8Array(RAIL_PATH_PACK_MAX_BYTES),
  });
  t.after(full.close);
  const served = await full.handle(request('/api/rail/paths/mta-lirr'));
  assert.equal(served.status, 200);
  assert.equal(
    (await served.arrayBuffer()).byteLength,
    RAIL_PATH_PACK_MAX_BYTES,
  );
});

test('the fs reader reads <id>.json from its directory and nothing else', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gev-rail-paths-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'mta-lirr.json'), '{"version":1}');
  await writeFile(path.join(dir, 'grt-ion.json'), 'x'.repeat(64));
  const read = createFsPathPackReader(dir);
  const pack = await read('mta-lirr');
  assert.ok(pack instanceof Uint8Array, 'bytes, never decoded to text');
  assert.equal(Buffer.from(pack).toString('utf8'), '{"version":1}');
  assert.equal(await read('mbta-rail'), null, 'no file');
  assert.equal(await read('../mta-lirr'), null, 'not an id');
  assert.equal(await read('MTA-LIRR'), null);
  await assert.rejects(read('grt-ion', { maxBytes: 10 }), (error) => {
    assert.match(error.message, /64 bytes/);
    assert.equal(error.code, 'PACK_TOO_LARGE');
    return true;
  });
  assert.equal((await read('grt-ion', { maxBytes: 64 })).length, 64);
});

test('the fs pack cache reads an unchanged pack once and a rebuilt one again', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gev-rail-cache-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mta-lirr.json');
  await writeFile(file, '{"version":1}');
  const cache = createRailPackCache(40);
  const read = createFsPathPackReader(dir, { cache });
  const [first, again] = await Promise.all([
    read('mta-lirr'),
    read('mta-lirr'),
  ]);
  assert.equal(first, again, 'one read shared by two at once');
  assert.equal(await read('mta-lirr'), first, 'kept while unchanged');
  assert.equal(cache.bytes(), 13);
  // A rebuild changes the size or the time: read again, the old copy gone.
  await writeFile(file, '{"version":22}');
  await utimes(file, new Date(), new Date(Date.now() + 5_000));
  const rebuilt = await read('mta-lirr');
  assert.notEqual(rebuilt, first);
  assert.equal(Buffer.from(rebuilt).toString('utf8'), '{"version":22}');
  assert.equal(cache.bytes(), 14);
  // The byte budget holds: the least recently read pack makes room.
  await writeFile(path.join(dir, 'mbta-rail.json'), 'x'.repeat(30));
  await read('mbta-rail');
  assert.equal(cache.bytes(), 30);
  // A pack over the whole byte budget is served but never kept.
  await writeFile(path.join(dir, 'grt-ion.json'), 'y'.repeat(41));
  assert.equal((await read('grt-ion')).length, 41);
  assert.equal(cache.bytes(), 30);
});

test('a served pack is streamed to the Node response as bytes, unchanged', async () => {
  const bytes = new TextEncoder().encode('{"paths":"é"}');
  const service = createRailService({ readPathPack: async () => bytes });
  try {
    const response = await service.handle(request('/api/rail/paths/mta-lirr'));
    const chunks = [];
    const head = {};
    const res = new Writable({
      write(chunk, encoding, done) {
        chunks.push(chunk);
        done();
      },
    });
    res.writeHead = (status, headers) =>
      Object.assign(head, { status, headers });
    await sendRailResponse(response, res);
    assert.equal(head.status, 200);
    assert.equal(head.headers['cache-control'], 'no-cache');
    const out = Buffer.concat(chunks);
    assert.deepEqual(new Uint8Array(out), bytes);
    // The reader's own buffer goes out: no decode, no copy.
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].buffer, bytes.buffer);
  } finally {
    service.close();
  }
});

/** A TripUpdates FeedMessage with one commuter-rail trip and one bus trip. */
function tripUpdateBytes() {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  header.writeVarintField(3, Math.floor(Date.now() / 1000));
  writer.writeBytesField(1, header.finish());
  for (const [id, route] of [
    ['cr-trip', 'CR-Providence'],
    ['bus-trip', '1'],
  ]) {
    const entity = new PbfWriter();
    entity.writeStringField(1, id);
    const update = new PbfWriter();
    const trip = new PbfWriter();
    trip.writeStringField(1, id);
    trip.writeStringField(5, route);
    update.writeBytesField(1, trip.finish());
    const stop = new PbfWriter();
    stop.writeStringField(4, 'place-sstat');
    const arrival = new PbfWriter();
    arrival.writeVarintField(1, 240);
    stop.writeBytesField(2, arrival.finish());
    update.writeBytesField(2, stop.finish());
    entity.writeBytesField(3, update.finish());
    writer.writeBytesField(2, entity.finish());
  }
  return writer.finish();
}

test('trip updates come from their own URL, cache and filter', async (t) => {
  const urls = [];
  const service = createRailService({
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(
        url.endsWith('TripUpdates.pb') ? tripUpdateBytes() : mbtaBytes(),
        { status: 200 },
      );
    },
  });
  t.after(service.close);
  const updates = await service.handle(request('/api/rail/updates/mbta-rail'));
  assert.equal(updates.status, 200);
  assert.equal(updates.headers.get('X-GEV-Cache'), 'MISS');
  assert.equal(updates.headers.get('cache-control'), 'public, max-age=30');
  const body = await updates.json();
  assert.equal(body.count, 1);
  assert.equal(body.dropped, 1, 'the bus trip never leaves the server');
  assert.deepEqual(
    {
      tripId: body.trips[0].tripId,
      routeId: body.trips[0].routeId,
      delaySec: body.trips[0].delaySec,
      stop: body.trips[0].stops[0],
    },
    {
      tripId: 'cr-trip',
      routeId: 'CR-Providence',
      delaySec: 240,
      stop: {
        stopId: 'place-sstat',
        stopSequence: null,
        arrival: { time: null, delay: 240 },
        departure: null,
      },
    },
  );
  // Positions are a separate cache entry: this is a MISS, not the updates.
  const trains = await service.handle(request('/api/rail/trains/mbta-rail'));
  assert.equal(trains.headers.get('X-GEV-Cache'), 'MISS');
  assert.equal((await trains.json()).trains[0].id, 'cr');
  const again = await service.handle(request('/api/rail/updates/mbta-rail'));
  assert.equal(again.headers.get('X-GEV-Cache'), 'HIT');
  assert.deepEqual(urls, [
    'https://cdn.mbta.com/realtime/TripUpdates.pb',
    'https://cdn.mbta.com/realtime/VehiclePositions.pb',
  ]);
  assert.equal(
    (await service.handle(request('/api/rail/updates/capmetro-rail'))).status,
    404,
    'a feed without trip updates has no /updates route',
  );
});

test('every train answer comes from the operator, never from a timetable', async (t) => {
  // A feed once answered `/trains` with an empty list for the timetable to
  // fill; every feed now reports its trains, so every answer is fetched.
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = warn;
  });
  const asked = [];
  const service = createRailService({
    fetchImpl: async (url) => {
      asked.push(url);
      return new Response('', { status: 503 });
    },
    hasSchedulePack: async () => true,
  });
  t.after(service.close);
  const feeds = railEnabledFeeds();
  for (const feed of feeds) {
    const response = await service.handle(
      request(`/api/rail/trains/${feed.id}`),
    );
    assert.equal(response.status, 502, feed.id);
    assert.equal(response.headers.get('X-GEV-Cache'), 'NONE', feed.id);
  }
  // Feeds that share one positions document are asked once per window.
  assert.equal(
    new Set(asked).size,
    new Set(feeds.map((feed) => feed.url)).size,
  );
});

test('Irish Rail is fetched as XML and served as event-positioned trains', async (t) => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ArrayOfObjTrainPositions xmlns="http://api.irishrail.ie/realtime/">
  <objTrainPositions>
    <TrainStatus>R</TrainStatus>
    <TrainLatitude>53.35</TrainLatitude>
    <TrainLongitude>-6.25</TrainLongitude>
    <TrainCode>A216</TrainCode>
    <TrainDate>06 Nov 2026</TrainDate>
    <PublicMessage>A216\\n14:00 - Dublin Heuston to Cork (9 mins late)\\nDeparted Thurles next stop Limerick Junction</PublicMessage>
    <Direction>To Cork</Direction>
  </objTrainPositions>
</ArrayOfObjTrainPositions>`;
  const seen = [];
  const service = createRailService({
    fetchImpl: async (url, init) => {
      seen.push([url, init.headers.Accept]);
      return new Response(xml, {
        status: 200,
        headers: { 'content-type': 'text/xml; charset=utf-8' },
      });
    },
  });
  t.after(service.close);
  const response = await service.handle(request('/api/rail/trains/irish-rail'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=30');
  const body = await response.json();
  assert.equal(body.positions, 'event');
  assert.equal(body.trains[0].id, 'A216');
  assert.equal(body.trains[0].category, 'national');
  assert.equal(body.trains[0].positionSource, 'event');
  // The message's next stop decides the status; it does not leave the server.
  assert.equal(body.trains[0].status, 'IN_TRANSIT_TO');
  assert.equal(body.trains[0].nextStop, undefined);
  // No schedule pack here: the train code alone classifies the train.
  assert.equal(body.count, 1);
  assert.deepEqual(seen, [
    [
      'https://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML',
      'text/xml, application/xml;q=0.9',
    ],
  ]);
});

test('an unreadable Irish Rail document is a 502 with backoff, not a crash', async (t) => {
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = warn;
  });
  const service = createRailService({
    fetchImpl: async () => new Response('<html>busy</html>', { status: 200 }),
  });
  t.after(service.close);
  const response = await service.handle(request('/api/rail/trains/irish-rail'));
  assert.equal(response.status, 502);
  const again = await service.handle(request('/api/rail/trains/irish-rail'));
  assert.equal(again.headers.get('X-Rail-Backoff'), 'cooldown');
});

test('an answer names its upstream host, and a failed fetch is a logged 504', async (t) => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = warn;
  });
  const service = createRailService({
    now: () => 1_800_000_000_000,
    fetchImpl: async () => new Response(mbtaBytes(), { status: 200 }),
  });
  t.after(service.close);
  const response = await service.handle(request('/api/rail/trains/mbta-rail'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Rail-Upstream'), 'cdn.mbta.com');
  assert.equal(response.headers.get('X-Rail-Contact'), '1800000000000');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=15');
  const failing = createRailService({
    fetchImpl: async (url) => {
      throw new TypeError(`fetch failed for ${url}`);
    },
  });
  t.after(failing.close);
  const failed = await failing.handle(request('/api/rail/trains/mbta-rail'));
  assert.equal(failed.status, 504);
  assert.equal((await failed.json()).error, 'Rail feed unavailable');
  assert.ok(
    warnings.some((line) => line.includes('trains:mbta-rail unavailable')),
  );
});

test('a redirect on the feed origin is followed, one hop at a time', async (t) => {
  const urls = [];
  const service = createRailService({
    fetchImpl: async (url, init) => {
      urls.push(url);
      assert.equal(init.redirect, 'manual');
      if (urls.length === 1)
        return new Response(null, {
          status: 302,
          headers: { location: '/realtime/VehiclePositions.pb?v=2' },
        });
      return new Response(mbtaBytes(), { status: 200 });
    },
  });
  t.after(service.close);
  const response = await service.handle(request('/api/rail/trains/mbta-rail'));
  assert.equal(response.status, 200);
  assert.deepEqual(urls, [
    'https://cdn.mbta.com/realtime/VehiclePositions.pb',
    'https://cdn.mbta.com/realtime/VehiclePositions.pb?v=2',
  ]);
  assert.equal(response.headers.get('X-Rail-Upstream'), 'cdn.mbta.com');
});

test('schedule packs are served from the injected reader', async (t) => {
  const asked = [];
  const pack = JSON.stringify({ version: 1, feedId: 'ktmb' });
  const service = createRailService({
    fetchImpl: async () => {
      throw new Error('a schedule request never reaches an operator');
    },
    readSchedulePack: async (feedId, options) => {
      asked.push([feedId, options.maxBytes]);
      return feedId === 'mbta-rail' ? null : pack;
    },
  });
  t.after(service.close);
  for (const id of ['ktmb', 'irish-rail']) {
    const response = await service.handle(request(`/api/rail/schedule/${id}`));
    assert.equal(response.status, 200, id);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(await response.text(), pack);
  }
  const none = await service.handle(request('/api/rail/schedule/mbta-rail'));
  assert.equal(none.status, 404);
  assert.equal((await none.json()).error, 'No rail schedule');
  for (const blocked of [
    '/api/rail/schedule/vre',
    '/api/rail/schedule/unknown',
    '/api/rail/schedule/..%2Fktmb',
  ])
    assert.equal((await service.handle(request(blocked))).status, 404, blocked);
  assert.deepEqual(asked, [
    ['ktmb', RAIL_PATH_PACK_MAX_BYTES],
    ['irish-rail', RAIL_PATH_PACK_MAX_BYTES],
    ['mbta-rail', RAIL_PATH_PACK_MAX_BYTES],
  ]);
  // No reader: 404; an oversized pack: 503, as for path packs.
  const bare = createRailService();
  t.after(bare.close);
  assert.equal(
    (await bare.handle(request('/api/rail/schedule/ktmb'))).status,
    404,
  );
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = warn;
  });
  const huge = createRailService({
    readSchedulePack: async () => new Uint8Array(RAIL_PATH_PACK_MAX_BYTES + 1),
  });
  t.after(huge.close);
  const refused = await huge.handle(request('/api/rail/schedule/ktmb'));
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).error, 'Rail schedule too large');
  // The path reader is not asked for a schedule, nor the reverse.
  const paths = createRailService({ readPathPack: async () => pack });
  t.after(paths.close);
  assert.equal(
    (await paths.handle(request('/api/rail/schedule/ktmb'))).status,
    404,
  );
});

test('the fs schedule reader reads <id>.schedule.json beside the path packs', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gev-rail-schedule-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'ktmb.schedule.json'), '{"version":1}');
  await writeFile(path.join(dir, 'ktmb.json'), '{"paths":true}');
  const read = createFsSchedulePackReader(dir);
  const text = async (pending) => Buffer.from(await pending).toString('utf8');
  assert.equal(await text(read('ktmb')), '{"version":1}');
  assert.equal(await read('irish-rail'), null);
  assert.equal(await read('../ktmb'), null);
  await assert.rejects(read('ktmb', { maxBytes: 3 }), /13 bytes/);
  assert.equal(
    await text(createFsPathPackReader(dir)('ktmb')),
    '{"paths":true}',
  );
});

test('a viewer of every region at once is not refused by the global cap', async (t) => {
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = warn;
  });
  const service = createRailService({
    now: () => 1_800_000_000_000,
    fetchImpl: async () => new Response(mbtaBytes(), { status: 200 }),
  });
  t.after(service.close);
  const { feeds } = await (
    await service.handle(request('/api/rail/feeds'))
  ).json();
  const backoffs = [];
  let requests = 0;
  for (const feed of feeds) {
    for (const route of feed.tripUpdates ? ['trains', 'updates'] : ['trains']) {
      requests += 1;
      const response = await service.handle(
        request(`/api/rail/${route}/${feed.id}`),
      );
      backoffs.push(response.headers.get('X-Rail-Backoff'));
    }
  }
  assert.ok(requests > 40, `${requests} resources, more than the old cap`);
  assert.ok(!backoffs.includes('rate-limited'), 'the global cap held back');
  assert.ok(railAdmissionGlobalMax() >= railNaturalRequestsPerMinute());
});

/** Positions with a trip id but no route, as Renfe's long-distance feed sends. */
function routelessBytes(trips) {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  header.writeVarintField(3, Math.floor(Date.now() / 1000) - 3600);
  writer.writeBytesField(1, header.finish());
  for (const tripId of trips) {
    const entity = new PbfWriter();
    entity.writeStringField(1, tripId);
    const vehicle = new PbfWriter();
    const trip = new PbfWriter();
    trip.writeStringField(1, tripId);
    vehicle.writeBytesField(1, trip.finish());
    const position = new PbfWriter();
    position.writeFloatField(1, 40.4);
    position.writeFloatField(2, -3.7);
    vehicle.writeBytesField(2, position.finish());
    entity.writeBytesField(4, vehicle.finish());
    writer.writeBytesField(2, entity.finish());
  }
  return writer.finish();
}

test('routes missing from a feed are read from its schedule pack, once an hour', async (t) => {
  let now = 1_800_000_000_000;
  const reads = [];
  const service = createRailService({
    now: () => now,
    fetchImpl: async () =>
      new Response(routelessBytes(['0419212026-11-06', '9999912026-11-06']), {
        status: 200,
      }),
    readSchedulePack: async (feedId, options) => {
      reads.push([feedId, options.maxBytes]);
      return JSON.stringify({
        version: 1,
        feedId: 'renfe-larga-distancia',
        trips: {
          '0419212026-11-06': { route: 'ALVIA~X~1700037606GL023' },
          other: { route: 'MD~S~1' },
        },
      });
    },
    hasSchedulePack: async () => true,
  });
  t.after(service.close);
  const path = '/api/rail/trains/renfe-larga-distancia';
  const body = await (await service.handle(request(path))).json();
  assert.equal(body.count, 1);
  assert.equal(body.dropped, 1, 'a trip the pack does not know');
  assert.equal(body.trains[0].category, 'national');
  assert.equal(body.trains[0].timestampSource, 'fetch');
  now += 20_000;
  await service.handle(request(path));
  assert.deepEqual(reads, [
    ['renfe-larga-distancia', RAIL_PATH_PACK_MAX_BYTES],
  ]);
  now += 61 * 60_000;
  await service.handle(request(path));
  assert.equal(reads.length, 2, 're-read after an hour');
});

test('a rebuilt schedule pack replaces the lookups within a minute', async (t) => {
  let now = 1_800_000_000_000;
  let version = 'built-1';
  let route = 'ALVIA~X~1';
  let reads = 0;
  let versionAsks = 0;
  const service = createRailService({
    now: () => now,
    fetchImpl: async () =>
      new Response(routelessBytes(['0419212026-11-06']), { status: 200 }),
    readSchedulePack: async () => {
      reads += 1;
      return JSON.stringify({
        version: 1,
        feedId: 'renfe-larga-distancia',
        trips: { '0419212026-11-06': { route } },
      });
    },
    hasSchedulePack: async () => true,
    schedulePackVersion: async () => {
      versionAsks += 1;
      return version;
    },
  });
  t.after(service.close);
  const path = '/api/rail/trains/renfe-larga-distancia';
  const routeNow = async () =>
    (await (await service.handle(request(path))).json()).trains[0].routeId;
  assert.equal(await routeNow(), 'ALVIA~X~1');
  assert.equal(reads, 1);
  // Unchanged: kept, and the version is not asked on every poll.
  now += 61_000;
  assert.equal(await routeNow(), 'ALVIA~X~1');
  assert.equal(reads, 1);
  const asks = versionAsks;
  now += 20_000;
  await routeNow();
  assert.equal(versionAsks, asks);
  // Rebuilt: the next check after the minute reads the new pack.
  version = 'built-2';
  route = 'AVE~X~2';
  now += 61_000;
  await routeNow();
  now += 16_000;
  assert.equal(await routeNow(), 'AVE~X~2');
  assert.equal(reads, 2, 'read once more, well inside the hour');
});

test('without a schedule pack, a feed that needs it is unavailable and the pack retried later', async (t) => {
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = warn;
  });
  let now = 1_800_000_000_000;
  let reads = 0;
  const service = createRailService({
    now: () => now,
    fetchImpl: async () =>
      new Response(routelessBytes(['0419212026-11-06']), { status: 200 }),
    readSchedulePack: async () => {
      reads += 1;
      return null;
    },
    // Listed (the probe says built), but the pack is gone when read.
    hasSchedulePack: async () => true,
  });
  t.after(service.close);
  const path = '/api/rail/trains/renfe-larga-distancia';
  // Every train needs the pack for its route: not a healthy empty feed.
  const response = await service.handle(request(path));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('X-Rail-Backoff'), 'schedule');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).error, 'Rail schedule unavailable');
  now += 20_000;
  await service.handle(request(path));
  assert.equal(reads, 1, 'not re-read on every poll');
  now += 6 * 60_000;
  await service.handle(request(path));
  assert.equal(reads, 2, 'retried after five minutes');
  // A feed that carries its own routes never asks for the pack.
  let asked = 0;
  const own = createRailService({
    fetchImpl: async () => new Response(mbtaBytes(), { status: 200 }),
    readSchedulePack: async () => {
      asked += 1;
      return null;
    },
  });
  t.after(own.close);
  await own.handle(request('/api/rail/trains/mbta-rail'));
  assert.equal(asked, 0);
});
