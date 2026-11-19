import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitService } from 'gods-eye-view/sources/transit-service';
import { createTransitSource } from 'gods-eye-view/layers/transit/source';

const request = (path, method = 'GET') => ({
  url: `https://example.test${path}`,
  method,
});

test('portable service confines requests to registered feeds and GET', async (t) => {
  let calls = 0;
  const service = createTransitService({
    fetchImpl: async () => {
      calls++;
      throw new Error('unexpected');
    },
  });
  t.after(service.close);
  for (const path of [
    '/other',
    '/api/transit/vehicles/unknown',
    '/api/transit/vehicles/https%3A%2F%2Fexample.test',
  ]) {
    assert.equal((await service.handle(request(path))).status, 404);
  }
  for (const method of ['POST', 'HEAD', 'TRACE']) {
    assert.equal(
      (await service.handle(request('/api/transit/feeds', method))).status,
      405,
    );
  }
  const response = await service.handle(request('/api/transit/feeds'));
  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).feeds.some((feed) => feed.id === 'mbta'));
  assert.equal(calls, 0);
  service.close();
  assert.equal(
    (await service.handle(request('/api/transit/feeds'))).status,
    503,
  );
});

test('source sends snapshots and bounded history through the supplied transport', async () => {
  const calls = [];
  const controller = new AbortController();
  const payload = {
    version: 1,
    feedId: 'mbta',
    vehicleId: 'bus 1',
    fixes: [],
    epochs: [],
  };
  const source = createTransitSource({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json(url.includes('/trail/') ? payload : { count: 0 });
    },
  });
  assert.deepEqual(
    await (
      await source.requestSnapshot('mbta', { signal: controller.signal })
    ).json(),
    { count: 0 },
  );
  assert.deepEqual(
    await source.getHistory('mbta', 'bus 1', { signal: controller.signal }),
    payload,
  );
  assert.deepEqual(
    calls.map(({ url }) => url),
    ['/api/transit/vehicles/mbta', '/api/transit/trail/mbta/bus%201'],
  );
  assert.ok(calls.every(({ init }) => init.signal === controller.signal));
  controller.abort();
  assert.throws(
    () => source.requestSnapshot('mbta', { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.throws(
    () => source.getHistory('mbta', 'bus 1', { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls.length, 2);
});

test('source retains history validation and never retries through another transport', async () => {
  let calls = 0;
  const source = createTransitSource({
    fetchImpl: async () => {
      calls++;
      return Response.json({
        version: 1,
        feedId: 'wrong',
        vehicleId: 'bus',
        fixes: [],
        epochs: [],
      });
    },
  });
  await assert.rejects(
    source.getHistory('mbta', 'bus'),
    /Invalid transit history response/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    source.getHistory('mbta', '../bus'),
    /Invalid transit vehicle identifier/,
  );
  assert.equal(calls, 1);
});

test('snapshot cancellation covers headers and body parsing', async () => {
  for (const phase of ['headers', 'body']) {
    const controller = new AbortController();
    const source = createTransitSource({
      fetchImpl: async () => {
        if (phase === 'headers') controller.abort();
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => {
            controller.abort();
            return { vehicles: [] };
          },
        };
      },
    });
    await assert.rejects(
      async () => {
        const response = await source.requestSnapshot('mbta', {
          signal: controller.signal,
        });
        await response.json();
      },
      { name: 'AbortError' },
    );
  }
});

test('the service POSTs Entur its query and fetches GTFS feeds with a plain GET', async (t) => {
  const inits = new Map();
  const service = createTransitService({
    fetchImpl: async (url, init) => {
      inits.set(url, init);
      return url.includes('entur')
        ? new Response(JSON.stringify({ data: { vehicles: [] } }), {
            status: 200,
          })
        : new Response(null, { status: 503 });
    },
  });
  t.after(service.close);
  await service.handle(request('/api/transit/vehicles/entur-norway'));
  await service.handle(request('/api/transit/vehicles/mbta'));
  const entur = inits.get('https://api.entur.io/realtime/v2/vehicles/graphql');
  assert.equal(entur.method, 'POST');
  assert.match(JSON.parse(entur.body).query, /vehicles/);
  assert.equal(entur.headers['ET-Client-Name'], 'gods-eye-view-transit');
  const mbta = [...inits].find(([url]) => !url.includes('entur'))[1];
  assert.equal(mbta.method, undefined);
  assert.equal(mbta.body, undefined);
});
