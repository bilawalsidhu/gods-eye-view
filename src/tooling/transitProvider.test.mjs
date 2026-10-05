import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import { transitProxy } from 'gods-eye-view/server/providers/transit';
import {
  TRANSIT_BACKOFF_LADDER_MS,
  TRANSIT_PROXY_TTL_MS,
} from 'gods-eye-view/sources/transit';

/** Mount the plugin and return a caller for its single route. */
function install(plugin, mode = 'configureServer') {
  const routes = new Map();
  plugin[mode]({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  assert.equal(routes.size, 1);
  return async (url = '/', method = 'GET') => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, {
          status,
          headers: new Headers(headers),
          headersSent: true,
        });
      },
      end(body) {
        this.body = body;
      },
    };
    await [...routes.values()][0]({ url, method }, res);
    return res;
  };
}

/** One GTFS-RT FeedMessage with the given header and vehicles. */
function feedBytes({
  incrementality = 0,
  timestamp = 1_700_000_000,
  vehicles = [],
}) {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  header.writeVarintField(2, incrementality);
  header.writeVarintField(3, timestamp);
  writer.writeBytesField(1, header.finish());
  for (const item of vehicles) {
    const entity = new PbfWriter();
    entity.writeStringField(1, item.id);
    const vehicle = new PbfWriter();
    const position = new PbfWriter();
    position.writeFloatField(1, item.lat);
    position.writeFloatField(2, item.lon);
    vehicle.writeBytesField(2, position.finish());
    vehicle.writeVarintField(5, item.timestamp ?? timestamp);
    const descriptor = new PbfWriter();
    descriptor.writeStringField(1, item.id);
    vehicle.writeBytesField(8, descriptor.finish());
    entity.writeBytesField(4, vehicle.finish());
    writer.writeBytesField(2, entity.finish());
  }
  return writer.finish();
}

function upstreamResponse({ status = 200, headers = {}, bytes = null }) {
  const map = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    body: null,
    async arrayBuffer() {
      const view = bytes || new Uint8Array(0);
      return view.buffer.slice(
        view.byteOffset,
        view.byteOffset + view.byteLength,
      );
    },
  };
}

/** A scripted upstream that records every request it is actually given. */
function scriptedUpstream(steps) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers || {}, redirect: init?.redirect });
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (typeof step === 'function') return step(url, init);
    return step;
  };
  return { fetchImpl, calls };
}

const FULL = feedBytes({
  vehicles: [{ id: 'bus-1', lat: 42.36, lon: -71.06 }],
});

test('a 304 revalidation is a success, not a redirect with a missing Location', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { fetchImpl, calls } = scriptedUpstream([
    upstreamResponse({ headers: { etag: 'W/"v1"' }, bytes: FULL }),
    upstreamResponse({ status: 304, headers: { etag: 'W/"v1"' } }),
    upstreamResponse({ status: 304, headers: { etag: 'W/"v1"' } }),
  ]);
  const call = install(transitProxy({ fetchImpl }));

  const first = await call('/vehicles/mbta');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-GEV-Cache'), 'MISS');
  assert.equal(JSON.parse(first.body).count, 1);

  // Past the freshness window the proxy asks again, conditionally.
  t.mock.timers.setTime(Date.now() + TRANSIT_PROXY_TTL_MS + 1_000);
  const second = await call('/vehicles/mbta');
  assert.equal(calls[1].headers['If-None-Match'], 'W/"v1"');
  assert.equal(second.status, 200, 'an unchanged feed is not a failure');
  // MISS, not STALE-ERROR: the refresh SUCCEEDED. Treating 304 as a redirect
  // made this a failure that happened to be masked by the serve-stale path.
  assert.equal(second.headers.get('X-GEV-Cache'), 'MISS');
  assert.equal(JSON.parse(second.body).count, 1);

  // And the third one too: a 304 must not have started a backoff ladder.
  t.mock.timers.setTime(Date.now() + TRANSIT_PROXY_TTL_MS + 1_000);
  const third = await call('/vehicles/mbta');
  assert.equal(third.status, 200);
  assert.equal(third.headers.get('X-GEV-Cache'), 'MISS');
  assert.equal(calls.length, 3, 'every poll past the TTL reached the operator');
  assert.equal(third.headers.get('Retry-After'), null);
  assert.equal(
    third.headers.get('X-Transit-Backoff'),
    null,
    'no ladder was started',
  );
});

test('a differential feed condemns the snapshot that preceded it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const differential = feedBytes({
    incrementality: 1,
    vehicles: [{ id: 'bus-1', lat: 42.36, lon: -71.06 }],
  });
  const { fetchImpl } = scriptedUpstream([
    upstreamResponse({ bytes: FULL }),
    upstreamResponse({ bytes: differential }),
    upstreamResponse({ bytes: differential }),
  ]);
  const call = install(transitProxy({ fetchImpl }));

  assert.equal((await call('/vehicles/mbta')).status, 200);

  t.mock.timers.setTime(Date.now() + TRANSIT_PROXY_TTL_MS + 1_000);
  const refused = await call('/vehicles/mbta');
  assert.equal(refused.status, 502);
  assert.match(JSON.parse(refused.body).error, /differential/);

  // The next caller arrives INSIDE the cooldown the failure just started, which
  // is precisely the path that used to hand back the condemned snapshot as a
  // 200 because it was still inside the serve-stale window.
  t.mock.timers.setTime(Date.now() + 2_000);
  const after = await call('/vehicles/mbta');
  assert.notEqual(
    after.status,
    200,
    `served ${after.status} with ${after.body}`,
  );
  assert.equal(after.headers.get('X-GEV-Cache'), 'NONE');
  assert.equal(after.headers.get('X-Transit-Backoff'), 'cooldown');
});

test('a failing operator is put on a cooldown instead of being re-asked every poll', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { fetchImpl, calls } = scriptedUpstream([
    upstreamResponse({ status: 500 }),
    upstreamResponse({ status: 500 }),
  ]);
  const call = install(transitProxy({ fetchImpl }));

  const failed = await call('/vehicles/mbta');
  assert.equal(failed.status, 502);
  assert.equal(
    failed.headers.get('Retry-After'),
    String(TRANSIT_BACKOFF_LADDER_MS[0] / 1000),
  );
  assert.equal(calls.length, 1);

  // Inside the cooldown the operator is not contacted at all.
  t.mock.timers.setTime(Date.now() + 1_000);
  const held = await call('/vehicles/mbta');
  assert.equal(held.status, 503);
  assert.equal(held.headers.get('X-Transit-Backoff'), 'cooldown');
  assert.equal(calls.length, 1, 'the operator was left alone');

  // Past the first rung it is tried again, and a second failure waits longer.
  t.mock.timers.setTime(Date.now() + TRANSIT_BACKOFF_LADDER_MS[0]);
  const retried = await call('/vehicles/mbta');
  assert.equal(calls.length, 2);
  assert.equal(
    retried.headers.get('Retry-After'),
    String(TRANSIT_BACKOFF_LADDER_MS[1] / 1000),
  );
});

test('a redirect is followed only within the feed origin, and never contacted first', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const sameOrigin = scriptedUpstream([
    upstreamResponse({
      status: 302,
      headers: { location: '/files/current.pb' },
    }),
    upstreamResponse({ bytes: FULL }),
  ]);
  const call = install(transitProxy({ fetchImpl: sameOrigin.fetchImpl }));
  const ok = await call('/vehicles/capmetro-austin');
  assert.equal(ok.status, 200);
  assert.equal(sameOrigin.calls.length, 2);
  assert.equal(
    sameOrigin.calls[1].url,
    'https://data.texas.gov/files/current.pb',
  );
  assert.equal(sameOrigin.calls[0].redirect, 'manual');

  const offOrigin = scriptedUpstream([
    upstreamResponse({
      status: 302,
      headers: { location: 'https://cdn.elsewhere.test/current.pb' },
    }),
    upstreamResponse({ bytes: FULL }),
  ]);
  const refuse = install(transitProxy({ fetchImpl: offOrigin.fetchImpl }));
  const blocked = await refuse('/vehicles/capmetro-austin');
  assert.equal(blocked.status, 504);
  assert.equal(
    offOrigin.calls.length,
    1,
    'the disallowed host was never contacted, only its Location read',
  );
});

test('only registered feed ids reach an operator', async (t) => {
  const { fetchImpl, calls } = scriptedUpstream([
    upstreamResponse({ bytes: FULL }),
  ]);
  const call = install(transitProxy({ fetchImpl }));
  for (const path of [
    '/vehicles/not-a-feed',
    '/vehicles/..%2F..%2Fetc',
    '/vehicles/',
    '/elsewhere',
  ]) {
    const missing = await call(path);
    assert.equal(missing.status, 404, `${path} is not a door to an upstream`);
  }
  assert.equal(calls.length, 0, 'no operator was contacted for any of them');
  const catalog = JSON.parse((await call('/feeds')).body);
  assert.ok(catalog.feeds.length > 0);
  for (const feed of catalog.feeds) {
    assert.equal('url' in feed, false);
    assert.equal('headers' in feed, false);
  }
});

test('a 304 reports that the operator answered, not that the body is new', async (t) => {
  // The body a revalidated feed keeps serving carries the fetch time of the
  // payload it holds, which stops advancing the moment the operator's file
  // stops changing. That is the right answer for "how old are these positions"
  // and the wrong one for "when did we last hear from them" — read as the
  // latter it aged a feed whose every request succeeded into silence.
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const firstAt = Date.now();
  const { fetchImpl } = scriptedUpstream([
    upstreamResponse({ headers: { etag: 'W/"v1"' }, bytes: FULL }),
    upstreamResponse({ status: 304, headers: { etag: 'W/"v1"' } }),
    upstreamResponse({ status: 304, headers: { etag: 'W/"v1"' } }),
  ]);
  const call = install(transitProxy({ fetchImpl }));

  const first = await call('/vehicles/mbta');
  assert.equal(Number(first.headers.get('X-Transit-Contact')), firstAt);
  assert.equal(JSON.parse(first.body).fetchedAt, firstAt);

  t.mock.timers.setTime(Date.now() + TRANSIT_PROXY_TTL_MS + 1_000);
  const revalidatedAt = Date.now();
  const second = await call('/vehicles/mbta');
  assert.equal(
    JSON.parse(second.body).fetchedAt,
    firstAt,
    'the positions are as old as they are',
  );
  assert.equal(
    Number(second.headers.get('X-Transit-Contact')),
    revalidatedAt,
    'but the operator answered just now',
  );

  // Served from the fresh cache, the contact time is the last real contact —
  // not the moment this request happened to arrive.
  const third = await call('/vehicles/mbta');
  assert.equal(third.headers.get('X-GEV-Cache'), 'HIT');
  assert.equal(Number(third.headers.get('X-Transit-Contact')), revalidatedAt);
});

test('a feed served from cache during an outage does not claim fresh contact', async (t) => {
  // The other half: STALE-ERROR must carry the LAST SUCCESSFUL contact, so the
  // browser can tell a revalidated feed from a dead one.
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const contactedAt = Date.now();
  const { fetchImpl } = scriptedUpstream([
    upstreamResponse({ bytes: FULL }),
    upstreamResponse({ status: 500 }),
    upstreamResponse({ status: 500 }),
  ]);
  const call = install(transitProxy({ fetchImpl }));
  await call('/vehicles/mbta');

  t.mock.timers.setTime(Date.now() + TRANSIT_PROXY_TTL_MS + 1_000);
  const during = await call('/vehicles/mbta');
  assert.equal(during.headers.get('X-GEV-Cache'), 'STALE-ERROR');
  assert.equal(
    Number(during.headers.get('X-Transit-Contact')),
    contactedAt,
    'silence does not count as an answer',
  );
});

// Include the provider-local storage contract in the repository's src test discovery.
import '../../server/providers/transitHistory.test.mjs';

test('history reads never fetch upstream, and 304/cache/failure replays never append', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });
  const { calls, fetchImpl } = scriptedUpstream([
    upstreamResponse({ bytes: FULL }),
    upstreamResponse({ status: 304 }),
    upstreamResponse({ status: 503 }),
  ]);
  const plugin = transitProxy({ fetchImpl });
  t.after(() => plugin.closeBundle());
  const call = install(plugin);
  const read = () => call('/trail/mbta/bus-1');
  assert.equal(JSON.parse((await read()).body).fixes.length, 0);
  assert.equal(calls.length, 0);
  await call('/vehicles/mbta');
  const initial = JSON.parse((await read()).body);
  assert.equal(initial.fixes.length, 1);
  await call('/vehicles/mbta');
  assert.equal(calls.length, 1);
  t.mock.timers.setTime(Date.now() + TRANSIT_PROXY_TTL_MS + 1);
  await call('/vehicles/mbta');
  assert.deepEqual(JSON.parse((await read()).body), initial);
  t.mock.timers.setTime(Date.now() + TRANSIT_PROXY_TTL_MS + 1);
  await call('/vehicles/mbta');
  assert.deepEqual(JSON.parse((await read()).body), initial);
  assert.equal(calls.length, 3);
  for (const path of [
    '/trail/mbta/%2Fescape',
    '/trail/mbta/abc%00bad',
    '/trail/mbta/%E0%A4%A',
    `/trail/mbta/${'a'.repeat(257)}`,
    '/trail/capmetro-austin/bus-1',
  ])
    assert.equal((await call(path)).status, 404);
  assert.equal(
    calls.length,
    3,
    'malformed and non-retained reads cannot reach an operator',
  );
});
test('history read admission is separate from upstream admission and closes with the server', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });
  const { calls, fetchImpl } = scriptedUpstream([
    upstreamResponse({ bytes: FULL }),
  ]);
  const plugin = transitProxy({ fetchImpl });
  t.after(() => plugin.closeBundle());
  const call = install(plugin);
  for (let i = 0; i < 30; i++)
    assert.equal((await call('/trail/mbta/bus-1')).status, 200);
  assert.equal((await call('/trail/mbta/bus-1')).status, 429);
  assert.equal(calls.length, 0);
  assert.equal((await call('/vehicles/mbta')).status, 200);
  assert.equal(calls.length, 1);
});

test('development and preview mount the same transit service and close it on shutdown', async () => {
  for (const mode of ['configureServer', 'configurePreviewServer']) {
    let close;
    let handler;
    const plugin = transitProxy({
      fetchImpl: async () => {
        throw new Error('unexpected upstream');
      },
    });
    plugin[mode]({
      middlewares: {
        use(path, fn) {
          assert.equal(path, '/api/transit');
          handler = fn;
        },
      },
      httpServer: {
        once(event, fn) {
          assert.equal(event, 'close');
          close = fn;
        },
      },
    });
    async function call(method) {
      const res = {
        writeHead(status) {
          this.status = status;
        },
        end() {},
      };
      await handler({ url: '/feeds', method }, res);
      return res.status;
    }
    assert.equal(await call('GET'), 200);
    assert.equal(await call('TRACE'), 405);
    close();
    assert.equal(await call('GET'), 503);
    plugin.closeBundle();
  }
});
