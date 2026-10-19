import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { saFireProxy } from '../../server/providers/saFire.js';

// Everything here is SYNTHETIC: the incidents fixture mirrors the public
// feed's shape, and the warnings payloads follow the published layer schemas
// (the live public-warnings layers were empty).
const incidentsBody = readFileSync(
  new URL('./fixtures/sa-fire-incidents.synthetic.json', import.meta.url),
  'utf8',
);
const MODIFIED = 'Tue, 13 Oct 2026 03:00:00 GMT';
const NOW0 = Date.UTC(2026, 9, 13, 3, 5);

const incidentsOk = () =>
  new Response(incidentsBody, {
    headers: { 'Content-Type': 'application/json', 'Last-Modified': MODIFIED },
  });
const fileUnavailable = () =>
  new Response('<html><body><h1>File Unavailable</h1></body></html>', {
    headers: { 'Content-Type': 'text/html' },
  });
const geojson = (features = [], extra = {}) =>
  new Response(
    JSON.stringify({ type: 'FeatureCollection', features, ...extra }),
    {
      headers: { 'Content-Type': 'application/geo+json;charset=UTF-8' },
    },
  );
const warningPolygon = (objectid = 1, expiry = NOW0 + 3_600_000) => ({
  type: 'Feature',
  id: objectid,
  properties: {
    objectid,
    name: 'Mount Compass',
    description: 'Synthetic test warning.',
    category: 'Watch and Act',
    public: 'True',
    expiry,
    expiry_with_offset: null,
    headline: 'Bushfire - Mount Compass',
    message_link: 'https://www.cfs.sa.gov.au/example',
  },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [138.6, -35.4],
        [138.8, -35.4],
        [138.8, -35.2],
        [138.6, -35.4],
      ],
    ],
  },
});

/** Route fixed upstream URLs to per-test handlers and record every call. */
function router(handlers = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const key =
      parsed.hostname === 'data.eso.sa.gov.au'
        ? 'incidents'
        : `layer${parsed.pathname.match(/FeatureServer\/(\d)\/query/)?.[1]}`;
    calls.push({ key, url: parsed, options });
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected upstream ${url}`);
    return handler(parsed, options, calls.filter((c) => c.key === key).length);
  };
  const count = (key) => calls.filter((call) => call.key === key).length;
  return { fetchImpl, calls, count };
}
const healthy = () => ({
  incidents: incidentsOk,
  layer0: () => geojson(),
  layer1: () => geojson([warningPolygon()]),
});

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = saFireProxy(options);
  assert.equal(plugin.name, 'sa-fire');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/sa-fire');
        handler = callback;
      },
    },
  });
  return async (url = '/', method = 'GET', peer = 'local') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: peer } }, res);
    return res;
  };
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: serves normalized incidents and warnings from fixed upstreams only`, async () => {
    const up = router(healthy());
    const request = install({ now: () => NOW0, fetchImpl: up.fetchImpl }, hook);
    const res = await request('/?url=https://evil.example&layer=9');
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['X-Data-Stale'], undefined);
    assert.equal(res.body.stale, false);
    assert.equal(res.body.incidents.length, 2);
    assert.equal(res.body.incidents[0].lat, -35.35);
    assert.equal(res.body.warningsAvailable, true);
    assert.equal(res.body.warnings.length, 1);
    assert.equal(res.body.warnings[0].id, 'g:1');
    assert.equal(res.body.incidentsFetchedAt, NOW0);
    assert.equal(res.body.warningsFetchedAt, NOW0);
    assert.equal(res.body.upstreamModified, Date.parse(MODIFIED));
    assert.equal(up.calls.length, 3);
    for (const { url, options } of up.calls) {
      assert.equal(url.protocol, 'https:');
      assert.ok(
        ['data.eso.sa.gov.au', 'cfs.geohub.sa.gov.au'].includes(url.hostname),
      );
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      assert.match(
        options.headers['User-Agent'],
        /^gods-eye-view-sa-fire-proxy\/1\.0 \(\+https:\/\/github\.com\//,
      );
    }
    const layer0 = up.calls.find((call) => call.key === 'layer0').url;
    assert.equal(
      layer0.pathname,
      '/server/rest/services/CFS_Warnings_Read/SACFS_Warnings_Public/FeatureServer/0/query',
    );
    assert.equal(
      layer0.search,
      '?where=1%3D1&outFields=*&outSR=4326&f=geojson',
    );
  });
}

test('an HTML "File Unavailable" page with HTTP 200 is a failure, never an empty list', async () => {
  let clock = NOW0;
  let serve = incidentsOk;
  const up = router({ ...healthy(), incidents: () => serve() });
  const request = install({ now: () => clock, fetchImpl: up.fetchImpl });
  const first = await request();
  assert.equal(first.body.incidents.length, 2);
  serve = fileUnavailable;
  clock += 60_000;
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.body.stale, true);
  assert.equal(res.headers['X-Data-Stale'], 'true');
  assert.equal(
    res.body.incidents.length,
    2,
    'last good data, not zero incidents',
  );
  assert.equal(res.body.incidentsFetchedAt, NOW0);
});

test('a first-ever HTML or wrong-content-type response is a sanitized 502', async () => {
  for (const response of [
    fileUnavailable,
    () =>
      new Response(incidentsBody, { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(incidentsBody),
    () =>
      new Response(incidentsBody, {
        headers: { 'Content-Type': 'text/plain' },
      }),
  ]) {
    const up = router({ ...healthy(), incidents: response });
    const request = install({ fetchImpl: up.fetchImpl });
    const res = await request();
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'sa_fire_unavailable' });
    assert.equal(res.headers['X-Data-Stale'], undefined);
  }
});

test('incident text that mentions a file page is data, not an error page', async () => {
  const odd = JSON.parse(incidentsBody);
  odd[0].location.name = 'File Unavailable Road';
  const up = router({
    ...healthy(),
    incidents: () =>
      new Response(JSON.stringify(odd), {
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  const res = await install({ now: () => NOW0, fetchImpl: up.fetchImpl })();
  assert.equal(res.status, 200);
  assert.equal(res.body.incidents[0].name, 'File Unavailable Road');
});

test('JSON that is not an array is a failure, and malformed JSON never caches', async () => {
  for (const body of ['{"incidents":[]}', 'null', '"x"', '{', '']) {
    let clock = 0;
    const up = router({
      ...healthy(),
      incidents: () =>
        new Response(body, { headers: { 'Content-Type': 'application/json' } }),
    });
    const request = install({ now: () => clock, fetchImpl: up.fetchImpl });
    assert.equal((await request()).status, 502, body);
    clock += 60_000;
    assert.equal((await request()).status, 502, body);
  }
});

test('upstream 5xx, 404 and network errors serve the last good snapshot as stale', async () => {
  for (const failure of [
    () => new Response('boom', { status: 503 }),
    () => new Response('gone', { status: 404 }),
    () => {
      throw new Error('private network detail');
    },
  ]) {
    let clock = NOW0;
    let serve = incidentsOk;
    const up = router({ ...healthy(), incidents: () => serve() });
    const request = install({ now: () => clock, fetchImpl: up.fetchImpl });
    await request();
    serve = failure;
    clock += 60_000;
    const res = await request();
    assert.equal(res.status, 200);
    assert.equal(res.body.stale, true);
    assert.equal(res.body.incidents.length, 2);
    assert.ok(!JSON.stringify(res.body).includes('private network detail'));
  }
});

test('a first-ever failure is 502 JSON; recovery then serves normally', async () => {
  let clock = 0;
  let failing = true;
  const up = router({
    ...healthy(),
    incidents: () =>
      failing ? new Response('no', { status: 500 }) : incidentsOk(),
  });
  const request = install({ now: () => clock, fetchImpl: up.fetchImpl });
  const failed = await request();
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.body, { error: 'sa_fire_unavailable' });
  assert.equal(failed.headers['Content-Type'], 'application/json');
  failing = false;
  clock += 60_000;
  const ok = await request();
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stale, false);
});

test('warnings fail independently of incidents', async () => {
  let clock = NOW0;
  let warningsDown = true;
  const up = router({
    ...healthy(),
    layer1: () =>
      warningsDown
        ? new Response('no', { status: 500 })
        : geojson([warningPolygon()]),
  });
  const request = install({ now: () => clock, fetchImpl: up.fetchImpl });
  const first = await request();
  assert.equal(first.status, 200);
  assert.equal(first.body.incidents.length, 2);
  assert.equal(
    first.body.warningsAvailable,
    false,
    'unavailable, not "no warnings"',
  );
  assert.deepEqual(first.body.warnings, []);
  assert.equal(first.body.warningsFetchedAt, null);
  assert.equal(first.body.stale, false, 'incidents are fresh');
  warningsDown = false;
  clock += 120_000 * 2; // past the failure backoff
  const second = await request();
  assert.equal(second.body.warningsAvailable, true);
  assert.equal(second.body.warnings.length, 1);
  // Later outage: last good warnings are served, flagged stale.
  warningsDown = true;
  clock += 120_000;
  const third = await request();
  assert.equal(third.body.warningsAvailable, true);
  assert.equal(third.body.warnings.length, 1);
  assert.equal(third.body.stale, true);
  assert.equal(third.headers['X-Data-Stale'], 'true');
});

test('incident failures never blank fresh warnings, and warnings are not required for a 200', async () => {
  let clock = NOW0;
  let serve = incidentsOk;
  const up = router({ ...healthy(), incidents: () => serve() });
  const request = install({ now: () => clock, fetchImpl: up.fetchImpl });
  await request();
  serve = fileUnavailable;
  clock += 120_000;
  const res = await request();
  assert.equal(res.body.stale, true);
  assert.equal(res.body.incidents.length, 2);
  assert.equal(res.body.warnings.length, 1);
  assert.equal(res.body.warningsAvailable, true);
});

test('warnings need both layers: a bad layer, wrong content type or ArcGIS error body is unavailable', async () => {
  for (const layer1 of [
    () =>
      new Response('<html>nope</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    () =>
      new Response('{"error":{"code":500}}', {
        headers: { 'Content-Type': 'application/json' },
      }),
    () =>
      new Response('{"features":"x"}', {
        headers: { 'Content-Type': 'application/json' },
      }),
    () =>
      new Response('File Unavailable', {
        headers: { 'Content-Type': 'application/json' },
      }),
    // Truncated data (transfer limit never clears) is not complete data.
    () => geojson([warningPolygon()], { exceededTransferLimit: true }),
  ]) {
    const up = router({ ...healthy(), layer1 });
    const request = install({ now: () => NOW0, fetchImpl: up.fetchImpl });
    const res = await request();
    assert.equal(res.status, 200);
    assert.equal(res.body.warningsAvailable, false);
    assert.deepEqual(res.body.warnings, []);
  }
});

test('incident and warning caches honour their own TTLs (injected clock)', async () => {
  let clock = NOW0;
  const up = router(healthy());
  const request = install({ now: () => clock, fetchImpl: up.fetchImpl });
  await request();
  assert.deepEqual(
    [up.count('incidents'), up.count('layer0'), up.count('layer1')],
    [1, 1, 1],
  );
  clock += 59_999;
  await request();
  assert.equal(up.count('incidents'), 1);
  clock += 1; // 60 s: incidents expire, warnings (120 s) do not
  await request();
  assert.equal(up.count('incidents'), 2);
  assert.equal(up.count('layer1'), 1);
  clock = NOW0 + 119_999;
  await request();
  assert.equal(up.count('layer1'), 1);
  clock = NOW0 + 120_000;
  await request();
  assert.equal(up.count('layer1'), 2);
  assert.equal(up.count('layer0'), 2);
});

test('failed upstreams back off: no retry inside the window, doubling, and Retry-After on 429', async () => {
  let clock = 0;
  const up = router({
    ...healthy(),
    incidents: () => new Response('no', { status: 500 }),
  });
  const request = install({ now: () => clock, fetchImpl: up.fetchImpl });
  await request();
  assert.equal(up.count('incidents'), 1);
  clock = 59_999;
  await request();
  assert.equal(up.count('incidents'), 1, 'not retried inside one TTL');
  clock = 60_000;
  await request();
  assert.equal(up.count('incidents'), 2);
  clock = 60_000 + 119_999; // second consecutive failure doubles the wait
  await request();
  assert.equal(up.count('incidents'), 2);
  clock = 60_000 + 120_000;
  await request();
  assert.equal(up.count('incidents'), 3);

  let limited = 0;
  clock = 0;
  const throttled = router({
    ...healthy(),
    incidents: () => {
      limited++;
      return new Response('slow down', {
        status: 429,
        headers: { 'Retry-After': '300' },
      });
    },
  });
  const request2 = install({
    now: () => clock,
    fetchImpl: throttled.fetchImpl,
  });
  await request2();
  clock = 299_999;
  await request2();
  assert.equal(limited, 1, 'Retry-After is honoured');
  clock = 300_000;
  await request2();
  assert.equal(limited, 2);
});

test('an upstream 429 without Retry-After still backs off, and a hostile Retry-After is capped', async () => {
  for (const [retryAfter, wait] of [
    [undefined, 600_000],
    ['999999999', 900_000],
    ['Mon, 01 Jan 2001 00:00:00 GMT', 60_000],
    ['soon', 600_000],
  ]) {
    let clock = NOW0;
    let calls = 0;
    const up = router({
      ...healthy(),
      incidents: () => {
        calls++;
        return new Response('x', {
          status: 429,
          headers: retryAfter ? { 'Retry-After': retryAfter } : {},
        });
      },
    });
    const request = install({ now: () => clock, fetchImpl: up.fetchImpl });
    await request();
    clock = NOW0 + wait - 1;
    await request();
    assert.equal(calls, 1, `${retryAfter}: still backing off`);
    clock = NOW0 + wait;
    await request();
    assert.equal(calls, 2, `${retryAfter}: retried after ${wait}`);
  }
});

test('non-OK upstream bodies are cancelled', async () => {
  let cancelled = false;
  const up = router({
    ...healthy(),
    incidents: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 500 },
      ),
  });
  const request = install({ fetchImpl: up.fetchImpl });
  assert.equal((await request()).status, 502);
  assert.equal(cancelled, true);
});

test('oversized declared and streamed bodies are capped, cancelled and sanitized', async () => {
  for (const key of ['incidents', 'layer1']) {
    const cap = key === 'incidents' ? 1024 * 1024 : 8 * 1024 * 1024;
    for (const declared of [true, false]) {
      let cancelled = false;
      const up = router({
        ...healthy(),
        [key]: () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(512 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            }),
            {
              headers: {
                'Content-Type': 'application/json',
                ...(declared ? { 'Content-Length': String(cap + 1) } : {}),
              },
            },
          ),
      });
      const request = install({ fetchImpl: up.fetchImpl });
      const res = await request();
      if (key === 'incidents') {
        assert.equal(res.status, 502);
        assert.deepEqual(res.body, { error: 'sa_fire_unavailable' });
      } else {
        assert.equal(res.status, 200);
        assert.equal(res.body.warningsAvailable, false);
      }
      assert.equal(cancelled, true, `${key} declared=${declared}`);
    }
  }
});

test('warning layers follow exceededTransferLimit with resultOffset and stop at the page cap', async () => {
  const offsets = [];
  const up = router({
    ...healthy(),
    layer1: (url, _options, n) => {
      offsets.push(url.searchParams.get('resultOffset'));
      return geojson([warningPolygon(n)], { exceededTransferLimit: n < 3 });
    },
  });
  const request = install({ now: () => NOW0, fetchImpl: up.fetchImpl });
  const res = await request();
  assert.deepEqual(offsets, [null, '1', '2']);
  assert.equal(res.body.warnings.length, 3);

  const endless = router({
    ...healthy(),
    layer1: (_url, _options, n) =>
      geojson([warningPolygon(n)], { exceededTransferLimit: true }),
  });
  const res2 = await install({
    now: () => NOW0,
    fetchImpl: endless.fetchImpl,
  })();
  assert.equal(endless.count('layer1'), 3);
  assert.equal(
    res2.body.warningsAvailable,
    false,
    'truncated data is not presented as complete',
  );
});

test('warnings that expire between refreshes are dropped when served', async () => {
  let clock = NOW0;
  const up = router({
    ...healthy(),
    layer1: () =>
      geojson([
        warningPolygon(1, NOW0 + 60_000),
        warningPolygon(2, NOW0 + 3_600_000),
      ]),
  });
  const request = install({ now: () => clock, fetchImpl: up.fetchImpl });
  assert.equal((await request()).body.warnings.length, 2);
  clock = NOW0 + 90_000; // inside the 120 s warnings TTL
  const res = await request();
  assert.equal(up.count('layer1'), 1);
  assert.deepEqual(
    res.body.warnings.map((row) => row.id),
    ['g:2'],
  );
});

test('concurrent requests share one upstream operation per feed', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const up = router({
    incidents: async () => {
      await gate;
      return incidentsOk();
    },
    layer0: () => geojson(),
    layer1: () => geojson(),
  });
  const request = install({ fetchImpl: up.fetchImpl });
  const pending = [
    request(),
    request('/', 'GET', 'b'),
    request('/', 'GET', 'c'),
  ];
  await new Promise(setImmediate);
  release();
  for (const res of await Promise.all(pending)) assert.equal(res.status, 200);
  assert.deepEqual(
    [up.count('incidents'), up.count('layer0'), up.count('layer1')],
    [1, 1, 1],
  );
});

test('non-GET methods are 405 and unknown sub-routes are 404 without fetching', async () => {
  const up = router(healthy());
  const request = install({ fetchImpl: up.fetchImpl });
  for (const method of ['POST', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
    const res = await request('/', method);
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.Allow, 'GET');
    assert.deepEqual(res.body, { error: 'method_not_allowed' });
  }
  for (const path of [
    '/incidents',
    '/warnings',
    '/inciweb/index',
    '/x/../',
    '//',
  ]) {
    const res = await request(path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(res.body, { error: 'unknown_route' });
  }
  assert.equal(up.calls.length, 0);
});

test('the per-client limit stops a loop while another client can read the cache', async () => {
  const up = router(healthy());
  const request = install({ now: () => NOW0, fetchImpl: up.fetchImpl });
  for (let i = 0; i < 60; i++) assert.equal((await request()).status, 200);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['Retry-After'], '60');
  assert.equal((await request('/', 'GET', 'another-client')).status, 200);
  assert.equal(up.count('incidents'), 1);
});
