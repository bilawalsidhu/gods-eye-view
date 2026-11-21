import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalAisHandler, parseLocalAisFeeds } from './local-ais.js';
import { localAisStatus } from '../../src/layers/localAis/status.js';

// Placeholder MMSIs and an open-ocean position; field names follow
// AIS-catcher's public ships.json documentation.
const NOW = 1_800_000_000_000;
const SHIP = Object.freeze({
  mmsi: 200000001,
  shipclass: 0,
  validated: 1,
  lat: 30.5,
  lon: -40.5,
  shipname: 'TEST VESSEL',
  last_signal: 2,
  speed: 9.4,
  cog: 77,
});
const URL_A = 'http://127.0.0.1:8100/api/ships.json';
const URL_B = 'http://127.0.0.1:8101/ships.json';

function call(handler, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const output = { code: 0, headers: {}, body: '' };
    const res = {
      writeHead(code, h) {
        output.code = code;
        output.headers = h;
      },
      end(body) {
        output.body = body || '';
        resolve(output);
      },
    };
    Promise.resolve(handler.handle({ method, headers }, res)).catch(reject);
  });
}

const json = (body) => new Response(JSON.stringify(body), { status: 200 });

function proxy(feedsValue, responses, extra = {}) {
  const logs = [];
  const handler = createLocalAisHandler({
    feedsValue,
    now: () => NOW,
    cacheMs: 0,
    logger: {
      warn: (line) => logs.push(['warn', line]),
      info: (line) => logs.push(['info', line]),
    },
    fetchImpl: async (url) => {
      const { pathname, port } = new URL(url);
      const reply = responses[pathname + port] ?? responses.default;
      return typeof reply === 'function' ? reply() : reply;
    },
    ...extra,
  });
  return { handler, logs };
}
const read = async (handler) => JSON.parse((await call(handler)).body);

test('LOCAL_AIS_FEEDS accepts private v0 AIS endpoints and rejects SSRF inputs', () => {
  const valid = parseLocalAisFeeds(
    'http://localhost:8100/api/ships.json,http://192.168.1.4:8100/ships.json',
  );
  assert.equal(valid.configured, true);
  assert.ok(valid.feeds.every((feed) => feed.url));
  for (const value of [
    'http://169.254.169.254/api/ships.json',
    'https://example.com/ships.json',
    'http://127.0.0.1:8100/api/ships.json?url=evil',
    'http://user:pass@localhost:8100/ships.json',
    'file:///etc/passwd',
    'http://localhost:8100/admin',
  ]) {
    const parsed = parseLocalAisFeeds(value);
    assert.equal(parsed.feeds[0].url, undefined, value);
    assert.ok(parsed.feeds[0].reason, value);
  }
});

test('a fifth feed is refused as too many', () => {
  const five = Array.from(
    { length: 5 },
    (_, i) => `http://127.0.0.1:${8100 + i}/ships.json`,
  ).join(',');
  const { feeds } = parseLocalAisFeeds(five);
  assert.equal(feeds.filter((feed) => feed.url).length, 4);
  assert.equal(feeds[4].reason, 'too many feeds');
});

test('a live receiver reports live with its vessel count and data age', async () => {
  const { handler, logs } = proxy(URL_A, { default: json({ ships: [SHIP] }) });
  const body = await read(handler);
  assert.equal(body.feeds[0].status, 'live');
  assert.equal(body.feeds[0].count, 1);
  assert.equal(body.feeds[0].heardAt, NOW - 2000);
  assert.equal(body.records[0].mmsi, '200000001');
  assert.deepEqual(logs, [['info', '[local-ais] AIS receiver 1 live']]);
});

test('an empty ship list is stale, never live', async () => {
  const { handler, logs } = proxy(URL_A, { default: json({ ships: [] }) });
  const body = await read(handler);
  assert.equal(body.feeds[0].status, 'stale');
  assert.equal(body.feeds[0].heardAt, null);
  assert.equal(body.records.length, 0);
  assert.match(logs[0][1], /stale \(NO_RECENT_MESSAGES\)/);
});

test('a receiver whose every row is refused is logged as rejected, not as silent', async () => {
  const { handler, logs } = proxy(URL_A, {
    default: json({
      ships: [
        { ...SHIP, validated: -1 },
        { ...SHIP, lat: 0, lon: 0 },
      ],
    }),
  });
  const body = await read(handler);
  assert.equal(body.feeds[0].status, 'stale');
  assert.equal(body.feeds[0].dropped, 2);
  // Refused rows still date the receiver's last activity: stale with an age.
  assert.equal(body.feeds[0].heardAt, NOW - 2000);
  assert.match(logs[0][1], /stale \(ROWS_REJECTED, 2 refused\)/);
  assert.doesNotMatch(logs[0][1], /NO_RECENT_MESSAGES/);
});

test('a receiver that hears only base stations and aids to navigation is quiet, not rejecting', async () => {
  const { handler, logs } = proxy(URL_A, {
    default: json({
      ships: [
        { ...SHIP, mmsi: 200000002, shipclass: 11 },
        { ...SHIP, mmsi: 200000003, shipclass: 12 },
      ],
    }),
  });
  const body = await read(handler);
  assert.equal(body.feeds[0].status, 'stale');
  assert.equal(body.feeds[0].dropped, 2);
  assert.equal(body.feeds[0].rejected, 0);
  assert.match(logs[0][1], /stale \(NO_RECENT_MESSAGES\)/);
  assert.doesNotMatch(logs[0][1], /ROWS_REJECTED/);
});

test('a quiet receiver whose list still holds a 50-minute-old refused row reads STALE, not rejected', async () => {
  const { handler, logs } = proxy(URL_A, {
    default: json({
      ships: [
        { ...SHIP, validated: -1, last_signal: 3000 },
        { ...SHIP, mmsi: 200000002, last_signal: 660 },
      ],
    }),
  });
  const body = await read(handler);
  const [receiver] = body.feeds;
  assert.equal(receiver.status, 'stale');
  assert.equal(receiver.rejected, 0);
  assert.equal(receiver.heardAt, NOW - 660_000, 'dated by its newest message');
  assert.match(logs[0][1], /stale \(NO_RECENT_MESSAGES\)/);
  assert.doesNotMatch(logs[0][1], /ROWS_REJECTED/);
  const status = localAisStatus({
    configured: true,
    feeds: body.feeds,
    heard: 0,
  });
  assert.equal(status.status, 'stale');
  assert.equal(status.error, undefined);
});

test('filtered classes are counted in the payload and date a receiver that hears only them', async () => {
  const { handler, logs } = proxy(URL_A, {
    default: json({
      ships: [
        { ...SHIP, mmsi: 200000002, shipclass: 9, last_signal: 30 },
        { ...SHIP, mmsi: 200000003, shipclass: 11, last_signal: 100 },
        { ...SHIP, mmsi: 200000004, shipclass: 12, last_signal: 200 },
        { ...SHIP, mmsi: 200000005, shipclass: 10, last_signal: 300 },
      ],
    }),
  });
  const body = await read(handler);
  const [receiver] = body.feeds;
  assert.equal(receiver.filtered, 4);
  assert.equal(receiver.rejected, 0);
  assert.equal(receiver.status, 'stale');
  assert.equal(receiver.heardAt, NOW - 30_000, 'alive, not silent');
  assert.equal(body.records.length, 0, 'nothing is drawn');
  assert.match(logs[0][1], /NO_RECENT_MESSAGES/);
  const status = localAisStatus({
    configured: true,
    feeds: body.feeds,
    heard: 0,
  });
  assert.equal(status.status, 'stale');
  assert.equal(status.error, undefined);
});

test('an old usable row beside fresh refused rows is reported as rejecting', async () => {
  const { handler, logs } = proxy(URL_A, {
    default: json({
      ships: [
        { ...SHIP, last_signal: 700 },
        { ...SHIP, mmsi: 200000002, validated: -1 },
      ],
    }),
  });
  const body = await read(handler);
  assert.equal(body.feeds[0].status, 'stale');
  assert.equal(body.feeds[0].rejected, 1);
  // The fresh refused row is a message too: it dates the receiver.
  assert.equal(body.feeds[0].heardAt, NOW - 2000);
  assert.match(logs[0][1], /stale \(ROWS_REJECTED, 1 refused\)/);
});

test('ROWS_REJECTED is logged when a feed enters the state, from stale too, and not every poll', async () => {
  let document = { ships: [] };
  const { handler, logs } = proxy(URL_A, {
    default: () => json(document),
  });
  await read(handler);
  assert.equal(logs.length, 1);
  assert.match(logs[0][1], /NO_RECENT_MESSAGES/);
  document = { ships: [{ ...SHIP, validated: -1 }] };
  await read(handler);
  await read(handler);
  await read(handler);
  const rejects = logs.filter(([, line]) => /ROWS_REJECTED/.test(line));
  assert.equal(rejects.length, 1, 'one line for entering, none per poll');
  assert.equal(logs.length, 2);
  // Back to merely quiet, then rejecting again: each entry is logged.
  document = { ships: [] };
  await read(handler);
  document = { ships: [{ ...SHIP, validated: -1 }] };
  await read(handler);
  assert.equal(logs.filter(([, line]) => /ROWS_REJECTED/.test(line)).length, 2);
});

test('rows older than ten minutes make the receiver stale and date it by its last message', async () => {
  const { handler } = proxy(URL_A, {
    default: json({ ships: [{ ...SHIP, last_signal: 601 }] }),
  });
  const body = await read(handler);
  assert.equal(body.feeds[0].status, 'stale');
  assert.equal(body.feeds[0].dropped, 1);
  assert.equal(body.feeds[0].heardAt, NOW - 601_000);
});

test('the 600 s edge is still live', async () => {
  const { handler } = proxy(URL_A, {
    default: json({ ships: [{ ...SHIP, last_signal: 600 }] }),
  });
  assert.equal((await read(handler)).feeds[0].status, 'live');
});

test('an envelope error makes the feed unreachable even with rows, and logs its code', async () => {
  for (const error of [true, 'receiver fault', 1]) {
    const { handler, logs } = proxy(URL_A, {
      default: json({ error, ships: [SHIP] }),
    });
    const body = await read(handler);
    assert.equal(body.feeds[0].status, 'unreachable', String(error));
    assert.equal(body.records.length, 0);
    assert.match(logs[0][1], /unreachable \(RECEIVER_ERROR\)/);
  }
  for (const error of [false, 0, '', 'false', null]) {
    const { handler } = proxy(URL_A, {
      default: json({ error, ships: [SHIP] }),
    });
    assert.equal((await read(handler)).feeds[0].status, 'live', String(error));
  }
});

test('HTTP failures are unreachable and log the error code once per change', async () => {
  const { handler, logs } = proxy(URL_A, {
    default: () => new Response(null, { status: 500 }),
  });
  await read(handler);
  await read(handler);
  assert.equal((await read(handler)).feeds[0].status, 'unreachable');
  assert.equal(logs.length, 1);
  assert.match(logs[0][1], /unreachable \(HTTP_STATUS\)/);
});

test('mixed feeds report each status; invalid feeds are named without their address', async () => {
  const { handler } = proxy(
    `${URL_A},${URL_B},https://example.com/ships.json`,
    {
      '/api/ships.json8100': json({ ships: [SHIP] }),
      '/ships.json8101': json({ ships: [] }),
    },
    { logger: { warn() {} } },
  );
  const body = await read(handler);
  assert.deepEqual(
    body.feeds.map((feed) => [feed.label, feed.status]),
    [
      ['AIS receiver 1', 'live'],
      ['AIS receiver 2', 'stale'],
      ['AIS receiver 3', 'invalid'],
    ],
  );
  assert.ok(!JSON.stringify(body).includes('example.com'));
});

test('a vessel heard by two feeds appears once, from the fresher feed', async () => {
  const { handler } = proxy(`${URL_A},${URL_B}`, {
    '/api/ships.json8100': json({
      ships: [{ ...SHIP, last_signal: 30, lat: 31 }],
    }),
    '/ships.json8101': json({ ships: [{ ...SHIP, last_signal: 4, lat: 32 }] }),
  });
  const body = await read(handler);
  assert.equal(body.records.length, 1);
  assert.equal(body.records[0].lat, 32);
  assert.equal(body.feeds[0].count, 1);
  assert.equal(body.feeds[1].count, 1);
});

test('no more than four feeds are read', async () => {
  const urls = [];
  const five = Array.from(
    { length: 5 },
    (_, i) => `http://127.0.0.1:${8100 + i}/ships.json`,
  ).join(',');
  const { handler } = proxy(
    five,
    {},
    {
      logger: { warn() {} },
      fetchImpl: async (url) => {
        urls.push(new URL(url).port);
        return json({ ships: [] });
      },
    },
  );
  const body = await read(handler);
  assert.equal(urls.length, 4);
  assert.equal(body.feeds.length, 5);
  assert.equal(body.feeds[4].status, 'invalid');
});

test('proxy relays normalized ships but not receiver station or upstream address', async () => {
  const { handler } = proxy(URL_A, {
    default: json({ station: { lat: 11.1, lon: 22.2 }, ships: [SHIP] }),
  });
  const text = (await call(handler)).body;
  assert.ok(!text.includes('127.0.0.1'));
  assert.ok(!text.includes('station'));
  assert.ok(!text.includes('11.1'));
});

test('unconfigured proxy makes no outbound requests', async () => {
  let fetches = 0;
  const handler = createLocalAisHandler({
    feedsValue: '',
    fetchImpl: async () => {
      fetches++;
      throw Error('should not fetch');
    },
  });
  const body = JSON.parse((await call(handler)).body);
  assert.equal(body.configured, false);
  assert.deepEqual(body.feeds, []);
  assert.equal(fetches, 0);
});

test('cross-site requests and methods other than GET or HEAD are refused', async () => {
  const handler = createLocalAisHandler({ feedsValue: '' });
  assert.equal(
    (await call(handler, 'GET', { 'sec-fetch-site': 'cross-site' })).code,
    403,
  );
  assert.equal((await call(handler, 'POST')).code, 405);
  assert.equal((await call(handler, 'HEAD')).body, '');
});

test('upstream redirects and invalid documents do not escape the local-only proxy', async () => {
  for (const upstream of [
    new Response(null, {
      status: 302,
      headers: { location: 'https://example.org' },
    }),
    json({ aircraft: [] }),
  ]) {
    const { handler } = proxy(URL_A, { default: upstream });
    const result = await read(handler);
    assert.equal(result.records.length, 0);
    assert.equal(result.feeds[0].status, 'unreachable');
  }
});

test('a receiver whose only row is a 50-minute-old refused one is dated by it, not "never"', async () => {
  const { handler } = proxy(URL_A, {
    default: json({ ships: [{ ...SHIP, validated: -1, last_signal: 3000 }] }),
  });
  const [receiver] = (await read(handler)).feeds;
  assert.equal(receiver.status, 'stale');
  assert.equal(
    receiver.rejected,
    0,
    'old refused data is stale, not rejecting',
  );
  assert.equal(receiver.heardAt, NOW - 3_000_000);
});

test('a beacon is a record on a live feed, with its own type, and dates newestAt', async () => {
  const { handler } = proxy(URL_A, {
    default: json({
      ships: [
        { ...SHIP, mmsi: 972000001, shipclass: 13, shipname: 'TEST MOB' },
        { ...SHIP, mmsi: 200000009, shipclass: 11, last_signal: 4 },
      ],
    }),
  });
  const body = await read(handler);
  const [receiver] = body.feeds;
  assert.equal(receiver.status, 'live', 'hearing a beacon is hearing');
  assert.equal(receiver.count, 1);
  assert.equal(receiver.filtered, 1, 'the base station is still filtered');
  assert.equal(receiver.newestAt, NOW - 2000);
  assert.equal(receiver.heardAt, NOW - 2000);
  assert.equal(body.records[0].beaconType, 'mob');
});

test('newestAt is the newest record a feed holds, and null with none', async () => {
  const { handler } = proxy(URL_A, {
    default: json({
      ships: [
        { ...SHIP, last_signal: 90 },
        { ...SHIP, mmsi: 200000002, last_signal: 30 },
      ],
    }),
  });
  assert.equal((await read(handler)).feeds[0].newestAt, NOW - 30_000);
  const quiet = proxy(URL_A, { default: json({ ships: [] }) });
  assert.equal((await read(quiet.handler)).feeds[0].newestAt, null);
});
