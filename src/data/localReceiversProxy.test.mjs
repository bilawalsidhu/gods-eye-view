import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LOCAL_RECEIVERS_ROUTE,
  createLocalReceiversHandler,
  localReceiversProxy,
  parseLocalReceiverFeeds,
} from '../../server/providers/local-receivers.js';
import { localProviderPlugins } from '../../server/providers/local.js';

const FIXTURE = readFileSync(
  new URL('./fixtures/adsb-austin-dump1090-aircraft.json', import.meta.url),
  'utf8',
);
const FIXTURE_NOW_MS = JSON.parse(FIXTURE).now * 1000;
const FEED_1090 = 'http://localhost:8080/data/aircraft.json';
const FEED_978 = 'http://127.0.0.1:8978/data/aircraft.json';

function quietLogger() {
  const lines = [];
  return {
    lines,
    warn: (line) => lines.push(line),
    info: (line) => lines.push(line),
  };
}

function respond(status = 200, body = FIXTURE, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function call(handler, method = 'GET') {
  const res = {
    writeHead(status, headers) {
      Object.assign(this, { status, headers });
    },
    end(body) {
      this.body = body;
    },
  };
  await handler.handle({ url: '/', method }, res);
  return { ...res, json: JSON.parse(res.body) };
}

test('LOCAL_RECEIVER_FEEDS accepts local http(s) aircraft.json feeds per band', () => {
  const { configured, feeds } = parseLocalReceiverFeeds(
    ` 1090=${FEED_1090} , 978=http://skyaware.local/skyaware978/data/aircraft.json,1090=https://192.168.1.20:8443/tar1090/data/aircraft.json`,
  );
  assert.equal(configured, true);
  assert.deepEqual(
    feeds.map(({ band, label, url }) => ({ band, label, url })),
    [
      { band: '1090', label: '1090 MHz #1', url: FEED_1090 },
      {
        band: '978',
        label: '978 MHz UAT',
        url: 'http://skyaware.local:80/skyaware978/data/aircraft.json',
      },
      {
        band: '1090',
        label: '1090 MHz #2',
        url: 'https://192.168.1.20:8443/tar1090/data/aircraft.json',
      },
    ],
  );
  assert.deepEqual(parseLocalReceiverFeeds(undefined), {
    configured: false,
    feeds: [],
  });
  assert.equal(parseLocalReceiverFeeds(' , ').configured, false);
});

test('LOCAL_RECEIVER_FEEDS rejects public, link-local and named hosts, bad paths and bands', () => {
  const cases = {
    '1090=http://8.8.8.8/data/aircraft.json': 'host must be',
    '1090=http://169.254.169.254/latest/aircraft.json': 'host must be',
    '1090=http://example.com/data/aircraft.json': 'host must be',
    '1090=http://[::1]:8080/data/aircraft.json': 'host must be',
    '1090=http://localhost:8080/data/receiver.json': 'path must end',
    '1090=http://localhost:8080/data/aircraft.json.bak': 'path must end',
    '1090=http://localhost:8080/data/aircraft.json?x=1': 'query',
    '1090=http://user:pw@localhost:8080/data/aircraft.json': 'credentials',
    '1090=ftp://localhost/data/aircraft.json': 'scheme',
    '1090=not a url': 'not a valid URL',
    '868=http://localhost:8080/data/aircraft.json': 'band must be',
    'http://localhost:8080/data/aircraft.json': 'expected band=url',
  };
  for (const [entry, reason] of Object.entries(cases)) {
    const [feed] = parseLocalReceiverFeeds(entry).feeds;
    assert.equal(feed.url, undefined, `${entry} must not be fetchable`);
    assert.match(feed.reason, new RegExp(reason), entry);
  }
  const [badBand] = parseLocalReceiverFeeds(
    '868=http://localhost/aircraft.json',
  ).feeds;
  assert.equal(badBand.band, null);
  assert.equal(badBand.label, 'entry 1');
});

test('an unconfigured route answers 200 without fetching anything', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('must not fetch');
  });
  const handler = createLocalReceiversHandler({
    feedsValue: undefined,
    logger: quietLogger(),
  });
  const res = await call(handler);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { configured: false, feeds: [], records: [] });
});

test('construction mounts the route once and neither parses nor fetches', (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('construction must not fetch');
  });
  const plugins = localProviderPlugins();
  assert.equal(
    plugins.filter((plugin) => plugin.name === 'local-receivers-proxy').length,
    1,
  );
  const routes = [];
  localReceiversProxy({
    feedsValue: '',
    logger: quietLogger(),
  }).configureServer({ middlewares: { use: (route) => routes.push(route) } });
  assert.deepEqual(routes, [LOCAL_RECEIVERS_ROUTE]);
});

test('live feeds are read in parallel and labelled with their band', async () => {
  const calls = [];
  const handler = createLocalReceiversHandler({
    feedsValue: `1090=${FEED_1090},978=${FEED_978}`,
    now: () => FIXTURE_NOW_MS + 2_000,
    logger: quietLogger(),
    fetchImpl: async (url, options) => {
      calls.push({ url, redirect: options.redirect });
      return respond();
    },
  });
  const { status, json } = await call(handler);
  assert.equal(status, 200);
  assert.deepEqual(
    calls.sort((a, b) => (a.url < b.url ? 1 : -1)),
    [
      { url: FEED_1090, redirect: 'manual' },
      { url: FEED_978, redirect: 'manual' },
    ],
  );
  assert.equal(json.configured, true);
  assert.deepEqual(json.feeds, [
    {
      band: '1090',
      label: '1090 MHz',
      status: 'live',
      aircraft: 4,
      ageMs: 2_000,
    },
    {
      band: '978',
      label: '978 MHz UAT',
      status: 'live',
      aircraft: 4,
      ageMs: 2_000,
    },
  ]);
  assert.equal(json.records.length, 8);
  const shinr = json.records.filter((record) => record.icao === 'ae5d8a');
  assert.deepEqual(
    shinr.map(({ band, source }) => ({ band, source })),
    [
      { band: '1090', source: 'feed' },
      { band: '978', source: 'feed' },
    ],
  );
  // Ages are anchored at the feed's own `now`.
  assert.equal(shinr[0].lastPositionAt, FIXTURE_NOW_MS - 34_600);
  assert.equal(shinr[0].lat, 30.269662);
});

test('a feed whose own now is over 10 s old is stale; failures are unreachable', async () => {
  const logger = quietLogger();
  const handler = createLocalReceiversHandler({
    feedsValue: [
      `1090=${FEED_1090}`,
      `978=${FEED_978}`,
      '1090=http://10.0.0.5/redirect/aircraft.json',
      '1090=http://10.0.0.6/big/aircraft.json',
      '1090=http://10.0.0.7/error/aircraft.json',
      '978=http://10.0.0.8/garbage/aircraft.json',
      '1090=http://8.8.8.8/aircraft.json',
    ].join(','),
    now: () => FIXTURE_NOW_MS + 10_001,
    logger,
    maxBytes: 4_096,
    fetchImpl: async (url) => {
      if (url === FEED_978) throw new TypeError('connect ECONNREFUSED secret');
      if (url.includes('/redirect/'))
        return respond(302, '', { location: 'http://169.254.169.254/' });
      if (url.includes('/big/'))
        return respond(200, `{"aircraft":[${' '.repeat(5_000)}]}`);
      if (url.includes('/error/'))
        return respond(500, 'upstream internal detail');
      if (url.includes('/garbage/')) return respond(200, '<html>');
      if (url.includes('8.8.8.8')) throw Error('invalid feed was fetched');
      return respond();
    },
  });
  const { json, body } = await call(handler);
  assert.deepEqual(
    json.feeds.map(({ band, status }) => `${band} ${status}`),
    [
      '1090 stale',
      '978 unreachable',
      '1090 unreachable',
      '1090 unreachable',
      '1090 unreachable',
      '978 unreachable',
      '1090 invalid',
    ],
  );
  assert.equal(json.feeds[0].ageMs, 10_001);
  assert.equal(json.records.length, 4, 'stale feed records still flow');
  for (const secret of ['ECONNREFUSED', 'secret', 'internal detail', '169.254'])
    assert.equal(body.includes(secret), false, `${secret} leaked`);
  assert.equal(
    body.includes('10.0.0'),
    false,
    'feed addresses stay server-side',
  );
  assert.ok(
    logger.lines.some((line) =>
      /LOCAL_RECEIVER_FEEDS feed-7 .* rejected: host must be/.test(line),
    ),
  );
  assert.ok(logger.lines.some((line) => /REDIRECT_REFUSED/.test(line)));
  assert.ok(logger.lines.some((line) => /RESPONSE_TOO_LARGE/.test(line)));
});

test('a feed that exceeds the timeout is unreachable', async () => {
  const handler = createLocalReceiversHandler({
    feedsValue: `1090=${FEED_1090}`,
    logger: quietLogger(),
    timeoutMs: 5,
    fetchImpl: (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  });
  const { json } = await call(handler);
  assert.equal(json.feeds[0].status, 'unreachable');
});

test('requests within a second share one read of every feed', async () => {
  let clock = FIXTURE_NOW_MS;
  let fetches = 0;
  const handler = createLocalReceiversHandler({
    feedsValue: `1090=${FEED_1090}`,
    now: () => clock,
    logger: quietLogger(),
    fetchImpl: async () => {
      fetches += 1;
      return respond();
    },
  });
  await Promise.all([call(handler), call(handler), call(handler)]);
  assert.equal(fetches, 1, 'concurrent requests are single-flight');
  clock += 500;
  await call(handler);
  assert.equal(fetches, 1, 'cached for about a second');
  clock += 1_000;
  await call(handler);
  assert.equal(fetches, 2);
  const res = await call(handler, 'POST');
  assert.equal(res.status, 405);
});

test('a feed name is resolved, every address checked, and the connection pinned to it', async () => {
  const lookups = [];
  const answers = {
    'good.local': [{ address: '10.0.0.9', family: 4 }],
    'public.local': [{ address: '93.184.216.34', family: 4 }],
    'linklocal.local': [{ address: '169.254.169.254', family: 4 }],
    'mixed.local': [
      { address: '192.168.1.4', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ],
  };
  const fetched = [];
  const logger = quietLogger();
  const handler = createLocalReceiversHandler({
    feedsValue: [
      '1090=http://good.local:8080/data/aircraft.json',
      '1090=http://public.local:8080/data/aircraft.json',
      '978=http://linklocal.local/data/aircraft.json',
      '978=http://mixed.local/data/aircraft.json',
      `1090=${FEED_978}`,
    ].join(','),
    now: () => FIXTURE_NOW_MS,
    logger,
    lookupImpl: async (hostname, options) => {
      lookups.push({ hostname, all: options?.all });
      return answers[hostname];
    },
    fetchImpl: async (url, options) => {
      fetched.push({ url, lookup: options.lookup });
      return respond();
    },
  });
  const { json } = await call(handler);
  assert.deepEqual(
    json.feeds.map(({ status }) => status),
    ['live', 'unreachable', 'unreachable', 'unreachable', 'live'],
  );
  assert.deepEqual(
    lookups.map(({ hostname }) => hostname).sort(),
    ['good.local', 'linklocal.local', 'mixed.local', 'public.local'],
    'IP literals are not resolved',
  );
  assert.ok(
    lookups.every(({ all }) => all === true),
    'every address',
  );
  assert.deepEqual(
    fetched.map(({ url }) => url).sort(),
    [FEED_978, 'http://good.local:8080/data/aircraft.json'],
    'a name resolving outside loopback/RFC1918 is never contacted',
  );
  // The connection resolves only to the validated address, whatever the
  // resolver would answer later.
  answers['good.local'] = [{ address: '93.184.216.34', family: 4 }];
  const pinned = fetched.find(({ url }) => url.includes('good.local')).lookup;
  assert.equal(typeof pinned, 'function');
  const one = await new Promise((resolve) =>
    pinned('good.local', {}, (error, address, family) =>
      resolve({ error, address, family }),
    ),
  );
  assert.deepEqual(one, { error: null, address: '10.0.0.9', family: 4 });
  const all = await new Promise((resolve) =>
    pinned('good.local', { all: true }, (error, addresses) =>
      resolve(addresses),
    ),
  );
  assert.deepEqual(all, [{ address: '10.0.0.9', family: 4 }]);
  assert.ok(logger.lines.some((line) => /FORBIDDEN_ADDRESS/.test(line)));
});

test('the default transport connects to the validated address, not a re-resolution', async (t) => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ now: FIXTURE_NOW_MS / 1000, aircraft: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  // `receiver-pin-test.local` has no real DNS entry: only the pinned lookup
  // can reach the loopback server.
  const handler = createLocalReceiversHandler({
    feedsValue: `1090=http://receiver-pin-test.local:${port}/data/aircraft.json`,
    now: () => FIXTURE_NOW_MS,
    logger: quietLogger(),
    lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  const { json } = await call(handler);
  assert.equal(json.feeds[0].status, 'live');
});
