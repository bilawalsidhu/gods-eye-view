// The schedule pack a feed's live trains are read with, and how packs are
// served: a pack of another format or feed, or whose window has ended, is
// refused; a pack-routed feed whose every record is dropped answers 503,
// not an empty list; a train named by its number keeps its run while its
// report says it is late; packs go out no-cache, with their version as
// their ETag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { PbfWriter } from 'pbf';
import { createRailService } from '../sources/railService.js';
import { railProxy } from '../../server/providers/rail.js';

/** 2027-01-15T08:00:00Z. */
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const LIVE_TRIP = '0419212026-11-06';

const request = (path, headers = undefined) => ({
  url: `https://example.test${path}`,
  method: 'GET',
  ...(headers ? { headers } : {}),
});

function quietWarnings(t) {
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = warn;
  });
}

/** Positions with a trip id but no route, as Renfe's long-distance feed sends. */
function routelessBytes(trips) {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  header.writeVarintField(3, Math.floor(NOW / 1000));
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

/**
 * A Renfe long-distance schedule pack whose trips run on 15 January 2027
 * (Madrid, UTC+1 then) from `startSec` local for `durationSec`.
 */
function renfePack({
  version = 1,
  feedId = 'renfe-larga-distancia',
  trips = [LIVE_TRIP],
  startSec = 9 * 3600,
  durationSec = 3600,
} = {}) {
  return JSON.stringify({
    version,
    feedId,
    timezone: 'Europe/Madrid',
    window: { from: '2027-01-14', to: '2027-01-15' },
    profiles: [[0, 0, durationSec, durationSec]],
    services: { S: ['2027-01-15'] },
    trips: Object.fromEntries(
      trips.map((tripId) => [
        tripId,
        {
          route: 'ALVIA~X~1700037606GL023',
          pattern: 0,
          profile: 0,
          startSec,
          service: 'S',
        },
      ]),
    ),
  });
}

function renfeService(t, readSchedulePack, clock = () => NOW) {
  const service = createRailService({
    now: clock,
    fetchImpl: async () =>
      new Response(routelessBytes([LIVE_TRIP]), { status: 200 }),
    readSchedulePack,
    hasSchedulePack: async () => true,
  });
  t.after(service.close);
  return service;
}

const TRAINS = '/api/rail/trains/renfe-larga-distancia';

async function assertScheduleUnavailable(response, label) {
  assert.equal(response.status, 503, label);
  assert.equal(response.headers.get('X-Rail-Backoff'), 'schedule', label);
  assert.equal(response.headers.get('cache-control'), 'no-store', label);
  assert.equal(
    (await response.json()).error,
    'Rail schedule unavailable',
    label,
  );
}

test('a pack that names none of the live trips is unavailable, not an empty feed', async (t) => {
  quietWarnings(t);
  // A pack built for other days: Renfe's trip ids carry their date.
  const service = renfeService(t, async () =>
    renfePack({ trips: ['0419212026-11-05'] }),
  );
  await assertScheduleUnavailable(await service.handle(request(TRAINS)));
});

test('a pack of another format, another feed or a window that has ended is refused', async (t) => {
  quietWarnings(t);
  // The same live train, the same trip in each pack: only the pack differs.
  const good = renfeService(t, async () => renfePack());
  const served = await (await good.handle(request(TRAINS))).json();
  assert.equal(served.count, 1);
  assert.equal(served.trains[0].routeId, 'ALVIA~X~1700037606GL023');
  for (const [label, pack] of [
    ['format version 2', renfePack({ version: 2 })],
    ['another feed', renfePack({ feedId: 'ktmb' })],
    // 04:00 to 05:00 UTC: over three hours before now.
    ['window ended', renfePack({ startSec: 5 * 3600 })],
  ]) {
    const service = renfeService(t, async () => pack);
    await assertScheduleUnavailable(
      await service.handle(request(TRAINS)),
      label,
    );
  }
});

test('a kept pack is refused once its window ends, and read again later', async (t) => {
  quietWarnings(t);
  let now = NOW;
  let reads = 0;
  // Its one run: 07:30 to 08:20 UTC.
  const service = renfeService(
    t,
    async () => {
      reads += 1;
      return renfePack({ startSec: 8.5 * 3600, durationSec: 50 * 60 });
    },
    () => now,
  );
  assert.equal((await service.handle(request(TRAINS))).status, 200);
  now += 21 * MIN;
  await assertScheduleUnavailable(await service.handle(request(TRAINS)));
  assert.equal(reads, 1, 'refused as kept, not read again');
  now += 6 * MIN;
  await service.handle(request(TRAINS));
  assert.equal(reads, 2, 'read again after five minutes');
});

/** Irish Rail's running trains, one train with its stated delay. */
function irishXml(minutesLate) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ArrayOfObjTrainPositions xmlns="http://api.irishrail.ie/realtime/">
  <objTrainPositions>
    <TrainStatus>R</TrainStatus><TrainLatitude>52.6</TrainLatitude>
    <TrainLongitude>-6.4</TrainLongitude><TrainCode>A610</TrainCode>
    <TrainDate>15 Jan 2027</TrainDate>
    <PublicMessage>A610\\n07:00 - Dublin Connolly to Rosslare Europort (${minutesLate} mins late)\\nDeparted Enniscorthy next stop Wexford</PublicMessage>
    <Direction>Southbound</Direction>
  </objTrainPositions>
</ArrayOfObjTrainPositions>`;
}

/** A610's run ends 07:45 UTC (Dublin is on UTC in January); A700 runs later. */
const IRISH_PACK = JSON.stringify({
  version: 1,
  feedId: 'irish-rail',
  timezone: 'Europe/Dublin',
  window: { from: '2027-01-14', to: '2027-01-15' },
  profiles: [[0, 0, 2700, 2700]],
  services: { S: ['2027-01-15'] },
  trips: {
    '6024_8435': {
      name: 'A610',
      route: 'A~X~DUB-EUROPORT-I',
      pattern: 0,
      profile: 0,
      startSec: 7 * 3600,
      service: 'S',
    },
    '6024_9000': {
      name: 'A700',
      route: 'A~X~DUB-EUROPORT-I',
      pattern: 0,
      profile: 0,
      startSec: 10 * 3600,
      service: 'S',
    },
  },
});

test('a late Irish Rail train keeps its run past its timetabled end', async (t) => {
  // Now is 15 minutes after the run's timetabled end, past the 10 minutes
  // a run is looked for around its times.
  const tripOf = async (minutesLate) => {
    const service = createRailService({
      now: () => NOW,
      fetchImpl: async () =>
        new Response(irishXml(minutesLate), { status: 200 }),
      readSchedulePack: async () => IRISH_PACK,
    });
    try {
      const body = await (
        await service.handle(request('/api/rail/trains/irish-rail'))
      ).json();
      return body.trains[0];
    } finally {
      service.close();
    }
  };
  const late = await tripOf(16);
  assert.equal(late.tripId, '6024_8435', '16 minutes late: still on its run');
  assert.equal(late.trainNumber, 'A610');
  assert.equal(late.delaySec, 960);
  const onTime = await tripOf(0);
  assert.equal(onTime.tripId, 'A610', 'on time: that run is over');
  assert.equal(onTime.trainNumber, undefined);
});

test('packs are served no-cache with their version as ETag, and 304 when unchanged', async (t) => {
  let pathVersion = '1731340000000.5:120';
  let reads = 0;
  const service = createRailService({
    readPathPack: async () => {
      reads += 1;
      return '{"paths":1}';
    },
    pathPackVersion: async () => pathVersion,
    readSchedulePack: async () => '{"schedule":1}',
    schedulePackVersion: async () => 'built-7',
  });
  t.after(service.close);
  const path = '/api/rail/paths/mta-lirr';
  const first = await service.handle(request(path));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const etag = first.headers.get('etag');
  assert.equal(etag, `"${encodeURIComponent(pathVersion)}"`);
  assert.equal(await first.text(), '{"paths":1}');
  // Asked again with its tag: 304, and the pack is not read.
  for (const headers of [
    { 'if-none-match': etag },
    new Headers({ 'If-None-Match': `W/${etag}, "other"` }),
  ]) {
    const again = await service.handle(request(path, headers));
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('etag'), etag);
    assert.equal(again.headers.get('cache-control'), 'no-cache');
    assert.equal(await again.text(), '');
  }
  assert.equal(reads, 1);
  // Rebuilt: the old tag gets the new pack.
  pathVersion = '1731340099000:140';
  const rebuilt = await service.handle(
    request(path, { 'if-none-match': etag }),
  );
  assert.equal(rebuilt.status, 200);
  assert.notEqual(rebuilt.headers.get('etag'), etag);
  assert.equal(reads, 2);
  // The schedule pack carries its own version.
  const schedule = await service.handle(request('/api/rail/schedule/mta-lirr'));
  assert.equal(schedule.headers.get('etag'), '"built-7"');
  assert.equal(
    (
      await service.handle(
        request('/api/rail/schedule/mta-lirr', {
          'if-none-match': '"built-7"',
        }),
      )
    ).status,
    304,
  );
  // Without a version there is no tag: no-cache, read each time.
  const bare = createRailService({ readPathPack: async () => '{}' });
  t.after(bare.close);
  const plain = await bare.handle(request(path, { 'if-none-match': '*' }));
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('etag'), null);
  assert.equal(plain.headers.get('cache-control'), 'no-cache');
});

test('the development server passes If-None-Match to the pack routes', async (t) => {
  const plugin = railProxy({
    readPathPack: async () => '{"paths":1}',
    pathPackVersion: async () => 'v1',
  });
  let handler = null;
  const server = {
    middlewares: {
      use(prefix, fn) {
        assert.equal(prefix, '/api/rail');
        handler = fn;
      },
    },
  };
  plugin.configureServer(server);
  t.after(() => plugin.closeBundle());
  const answer = async (headers) => {
    const head = {};
    const chunks = [];
    const res = new Writable({
      write(chunk, encoding, done) {
        chunks.push(chunk);
        done();
      },
    });
    res.writeHead = (status, sent) => Object.assign(head, { status, sent });
    const ended = new Promise((resolve) => res.on('finish', resolve));
    await handler({ url: '/paths/mta-lirr', method: 'GET', headers }, res);
    await ended;
    return { ...head, body: Buffer.concat(chunks).toString('utf8') };
  };
  const first = await answer({});
  assert.equal(first.status, 200);
  assert.equal(first.sent.etag, '"v1"');
  assert.equal(first.body, '{"paths":1}');
  const again = await answer({ 'if-none-match': '"v1"' });
  assert.equal(again.status, 304);
  assert.equal(again.body, '');
});
