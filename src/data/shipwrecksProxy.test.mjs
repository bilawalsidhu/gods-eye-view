import test from 'node:test';
import assert from 'node:assert/strict';
import { shipwrecksProxy } from '../../server/providers/shipwrecks.js';

const EMODNET = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'heritageshipwrecks.1',
      geometry: { type: 'Point', coordinates: [-0.92, 50.74] },
      properties: { name: 'HMS/m A1', sink_yr: '1911', country: 'UK' },
    },
  ],
};

const WIKIDATA = {
  results: {
    bindings: [
      {
        item: { value: 'http://www.wikidata.org/entity/Q25173' },
        itemLabel: { value: 'Titanic' },
        coord: { value: 'Point(-49.9469 41.7325)' },
      },
    ],
  },
};

/**
 * Upstream fake. Each source answers 'ok', 'down' (HTTP 503) or 'malformed'
 * (HTTP 200 with a body that is not that source's data); change `state` to
 * switch between requests.
 */
function fakeFetch({ wikidataFails = false, emodnetFails = false } = {}) {
  const calls = [];
  const state = {
    emodnet: emodnetFails ? 'down' : 'ok',
    wikidata: wikidataFails ? 'down' : 'ok',
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const href = String(url);
    const name = href.includes('query.wikidata.org')
      ? 'wikidata'
      : href.includes('ows.emodnet-humanactivities.eu')
        ? 'emodnet'
        : null;
    if (!name) return new Response('', { status: 404 });
    if (state[name] === 'down') return new Response('', { status: 503 });
    if (state[name] === 'malformed') return Response.json({});
    return Response.json(name === 'wikidata' ? WIKIDATA : EMODNET);
  };
  const callsTo = (name) =>
    calls.filter(({ url }) =>
      url.includes(
        name === 'wikidata'
          ? 'query.wikidata.org'
          : 'ows.emodnet-humanactivities',
      ),
    ).length;
  return { fetchImpl, calls, state, callsTo };
}

const HOUR = 60 * 60 * 1000;

function handlerOf(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return handler;
}

function request(handler, { method = 'GET', url = '/' } = {}) {
  return new Promise((resolve) => {
    const res = {
      destroyed: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({
          status: this.status,
          headers: this.headers,
          body: JSON.parse(body),
        });
      },
    };
    handler(
      { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      res,
    );
  });
}

test('serves one cached snapshot from fixed upstreams', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const handler = handlerOf(shipwrecksProxy({ fetchImpl }));
  const first = await request(handler);
  assert.equal(first.status, 200);
  assert.equal(first.body.records.length, 2);
  const a1 = first.body.records.find((record) => record.name === 'HMS/m A1');
  assert.equal(a1.year, 1911);
  assert.deepEqual(first.body.sources, { emodnet: true, wikidata: true });
  for (const { url } of calls)
    assert.match(
      url,
      /^https:\/\/(ows\.emodnet-humanactivities\.eu\/wfs\?|query\.wikidata\.org\/sparql\?)/,
    );
  const count = calls.length;
  await request(handler);
  assert.equal(calls.length, count, 'second request is served from cache');
});

test('one failing source still serves the other; both failing is a 502', async () => {
  const partial = handlerOf(
    shipwrecksProxy({
      fetchImpl: fakeFetch({ wikidataFails: true }).fetchImpl,
    }),
  );
  const ok = await request(partial);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.sources, { emodnet: true, wikidata: false });

  const down = handlerOf(
    shipwrecksProxy({
      fetchImpl: fakeFetch({ wikidataFails: true, emodnetFails: true })
        .fetchImpl,
    }),
  );
  assert.equal((await request(down)).status, 502);
});

test('a failed refresh serves the last snapshot as stale', async () => {
  let clock = 0;
  let fail = false;
  const { fetchImpl: good } = fakeFetch();
  const { fetchImpl: bad } = fakeFetch({
    wikidataFails: true,
    emodnetFails: true,
  });
  const handler = handlerOf(
    shipwrecksProxy({
      fetchImpl: (...args) => (fail ? bad : good)(...args),
      now: () => clock,
    }),
  );
  await request(handler);
  fail = true;
  clock = 25 * 60 * 60 * 1000;
  const stale = await request(handler);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
});

test('rejects other methods and routes', async () => {
  const handler = handlerOf(
    shipwrecksProxy({ fetchImpl: fakeFetch().fetchImpl }),
  );
  assert.equal((await request(handler, { method: 'POST' })).status, 405);
  assert.equal((await request(handler, { url: '/x' })).status, 404);
});

test("a refresh that gets nothing usable keeps every source's last good wrecks", async () => {
  let clock = 0;
  const upstream = fakeFetch();
  const handler = handlerOf(
    shipwrecksProxy({ fetchImpl: upstream.fetchImpl, now: () => clock }),
  );
  const first = await request(handler);
  assert.equal(first.body.records.length, 2);
  // A day later EMODnet is down and Wikidata answers 200 with no results.
  upstream.state.emodnet = 'down';
  upstream.state.wikidata = 'malformed';
  clock = 25 * HOUR;
  const later = await request(handler);
  assert.equal(later.status, 200);
  assert.equal(later.body.records.length, 2, 'no wreck is lost');
  assert.deepEqual(later.body.sources, { emodnet: true, wikidata: true });
  assert.equal(later.body.stale, true);
  assert.equal(later.body.fetchedAt, 0, 'the age of the oldest data served');
});

test('one source failing keeps its own last records while the other refreshes', async () => {
  let clock = 0;
  const upstream = fakeFetch();
  const handler = handlerOf(
    shipwrecksProxy({ fetchImpl: upstream.fetchImpl, now: () => clock }),
  );
  const first = await request(handler);
  assert.equal((await request(handler)).body.version, first.body.version);
  upstream.state.wikidata = 'down';
  clock = 25 * HOUR;
  const later = await request(handler);
  assert.notEqual(later.body.version, first.body.version, 'new EMODnet data');
  assert.equal(later.body.records.length, 2);
  assert.deepEqual(later.body.sources, { emodnet: true, wikidata: true });
  assert.equal(later.body.stale, true);
  assert.equal(upstream.callsTo('emodnet'), 2, 'EMODnet was refreshed');
  assert.deepEqual(later.body.ages, { emodnet: 0, wikidata: 25 * HOUR });
  assert.equal(later.body.maxAgeMs, 7 * 24 * HOUR);
});

test('a failed source waits before it is asked again', async () => {
  let clock = 0;
  const upstream = fakeFetch();
  const handler = handlerOf(
    shipwrecksProxy({ fetchImpl: upstream.fetchImpl, now: () => clock }),
  );
  await request(handler);
  upstream.state.emodnet = 'down';
  upstream.state.wikidata = 'down';
  clock = 25 * HOUR;
  await request(handler);
  const asked = upstream.calls.length;
  for (let i = 0; i < 10; i += 1) {
    clock += 60 * 1000;
    const res = await request(handler);
    assert.equal(res.status, 200);
    assert.equal(res.body.stale, true);
  }
  assert.equal(upstream.calls.length, asked, 'no upstream call while waiting');
  clock = 25 * HOUR + 16 * 60 * 1000;
  upstream.state.emodnet = 'ok';
  upstream.state.wikidata = 'ok';
  const back = await request(handler);
  assert.equal(
    upstream.calls.length,
    asked + 2,
    'both are retried after the wait',
  );
  assert.equal(back.body.stale, undefined);
});

test('with no data yet, failures are retried only after the wait', async () => {
  let clock = 0;
  const upstream = fakeFetch({ emodnetFails: true, wikidataFails: true });
  const handler = handlerOf(
    shipwrecksProxy({ fetchImpl: upstream.fetchImpl, now: () => clock }),
  );
  assert.equal((await request(handler)).status, 502);
  const asked = upstream.calls.length;
  clock += 5 * 60 * 1000;
  assert.equal((await request(handler)).status, 502);
  assert.equal(upstream.calls.length, asked);
  clock += 11 * 60 * 1000;
  assert.equal((await request(handler)).status, 502);
  assert.equal(upstream.calls.length, asked * 2);
});

test('a source older than seven days is no longer served', async () => {
  let clock = 0;
  const upstream = fakeFetch();
  const handler = handlerOf(
    shipwrecksProxy({ fetchImpl: upstream.fetchImpl, now: () => clock }),
  );
  await request(handler);
  upstream.state.emodnet = 'down';
  upstream.state.wikidata = 'down';
  clock = 7 * 24 * HOUR;
  assert.equal((await request(handler)).status, 200, 'seven days is served');
  clock = 7 * 24 * HOUR + 16 * 60 * 1000;
  assert.equal((await request(handler)).status, 502, 'older is dropped');
});

test('an upstream body over its cap is a failed source, read only to the cap', async () => {
  const MIB = 1024 * 1024;
  const chunk = new Uint8Array(MIB).fill(0x20);
  let sent = 0;
  let cancelled = false;
  const endless = () =>
    new ReadableStream({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
  const handler = handlerOf(
    shipwrecksProxy({
      fetchImpl: async (url) =>
        String(url).includes('query.wikidata.org')
          ? Response.json(WIKIDATA)
          : new Response(endless()),
    }),
  );
  const res = await request(handler);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.sources, { emodnet: false, wikidata: true });
  assert.ok(cancelled, 'the oversized body is cancelled');
  assert.ok(sent <= 34 * MIB, `read ${sent / MIB} MiB of a 32 MiB cap`);
});

test('a refresh far smaller than the last good set is refused until it expires', async () => {
  let clock = 0;
  const many = {
    results: {
      bindings: Array.from({ length: 10 }, (_, i) => ({
        item: { value: `http://www.wikidata.org/entity/Q${100 + i}` },
        itemLabel: { value: `Wreck ${i}` },
        coord: { value: `Point(${i} 40)` },
      })),
    },
  };
  let wikidata = many;
  const handler = handlerOf(
    shipwrecksProxy({
      fetchImpl: async (url) =>
        Response.json(
          String(url).includes('query.wikidata.org') ? wikidata : EMODNET,
        ),
      now: () => clock,
    }),
  );
  assert.equal((await request(handler)).body.records.length, 11);
  wikidata = WIKIDATA;
  clock = 25 * HOUR;
  const refused = await request(handler);
  assert.equal(refused.body.records.length, 11, 'one wreck is not ten');
  assert.equal(refused.body.stale, true);
  clock = 8 * 24 * HOUR;
  const accepted = await request(handler);
  assert.equal(
    accepted.body.records.length,
    2,
    'taken once the old set expired',
  );
});
