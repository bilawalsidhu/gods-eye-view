import test from 'node:test';
import assert from 'node:assert/strict';
import { firePerimetersProxy } from '../../server/providers/firePerimeters.js';

const incidentHtml = `<meta property="og:updated_time" content="2026-09-23T11:32:31-04:00" />
<th>Date of Origin</th>
<td class="text-tabular text-left"><time datetime="2026-07-15T20:20:00Z">Origin</time></td>`;
const incidentTimes = {
  createdMs: Date.parse('2026-07-15T20:20:00Z'),
  changedMs: Date.parse('2026-09-23T11:32:31-04:00'),
};
const incidentRedirect = () =>
  new Response('redirect', {
    status: 301,
    headers: { location: 'http://inciweb.wildfire.gov/test-fire' },
  });

const feature = (id = 'fire') => ({
  properties: { attr_UniqueFireIdentifier: id, poly_DateCurrent: 123 },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-108, 35],
        [-107, 35],
        [-107, 36],
        [-108, 35],
      ],
    ],
  },
});
function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = firePerimetersProxy(options);
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/fire-perimeters');
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
  test(`${hook}: paging stops at five pages and normalizes the combined snapshot`, async () => {
    const calls = [];
    const request = install(
      {
        now: () => 1234,
        fetchImpl: async (url, options) => {
          calls.push(new URL(url));
          assert.ok(options.signal instanceof AbortSignal);
          assert.equal(options.redirect, 'error');
          return Response.json({
            features: [feature(String(calls.length))],
            exceededTransferLimit: true,
          });
        },
      },
      hook,
    );
    const res = await request('/?url=https://invalid.example&resultOffset=999');
    assert.equal(res.status, 200);
    assert.equal(res.body.fetchedAt, 1234);
    assert.equal(res.body.rows.length, 5);
    assert.deepEqual(
      calls.map((url) => url.searchParams.get('resultOffset')),
      [null, '1', '2', '3', '4'],
    );
    assert.ok(calls.every((url) => url.hostname === 'services3.arcgis.com'));
    assert.equal(calls[0].searchParams.get('maxAllowableOffset'), '0.001');
  });
}

test('an explicit transfer-limit false stops paging; a fresh cache does not fetch', async () => {
  let calls = 0;
  const request = install({
    fetchImpl: async () => {
      calls++;
      return Response.json({
        features: [feature()],
        exceededTransferLimit: false,
      });
    },
  });
  const first = await request();
  assert.deepEqual((await request()).body, first.body);
  assert.equal(calls, 1);
});

test('a failed refresh serves the last good perimeter snapshot as stale', async () => {
  let clock = 0,
    calls = 0;
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      if (++calls > 1) throw new Error('private upstream details');
      return Response.json({ features: [feature()] });
    },
  });
  await request();
  clock = 300_000;
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.body.stale, true);
  assert.equal(res.body.fetchedAt, 0);
  assert.equal(res.body.rows[0].stableId, 'fire');
});

test('oversized streamed and declared bodies produce sanitized 502 responses', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const request = install({
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: declared
              ? { 'Content-Length': String(17 * 1024 * 1024) }
              : {},
          },
        ),
    });
    const res = await request();
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'fire_perimeters_unavailable' });
    assert.equal(cancelled, true);
  }
});

test('malformed WFIGS data does not become a cached empty snapshot', async () => {
  let calls = 0;
  const request = install({
    fetchImpl: async () => {
      calls++;
      return Response.json({ error: 'upstream detail' });
    },
  });
  assert.equal((await request()).status, 502);
  assert.equal((await request()).status, 502);
  assert.equal(calls, 2);
});

test('concurrent requests share one upstream operation for every route', async () => {
  for (const [path, payload] of [
    ['/', { features: [] }],
    ['/inciweb/index', []],
    ['/inciweb/publication/42', {}],
  ]) {
    let release,
      calls = 0;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const request = install({
      fetchImpl: async () => {
        calls++;
        await pending;
        if (path.includes('/publication/'))
          return calls === 1 ? incidentRedirect() : new Response(incidentHtml);
        return Response.json(payload);
      },
    });
    const responses = [request(path), request(path)];
    await new Promise(setImmediate);
    assert.equal(calls, 1);
    release();
    for (const res of await Promise.all(responses))
      assert.equal(res.status, 200);
    assert.equal(calls, path.includes('/publication/') ? 2 : 1);
  }
});

test('bad publication ids and non-GET requests never fetch upstream', async () => {
  let calls = 0;
  const request = install({
    fetchImpl: async () => {
      calls++;
      throw new Error('unexpected');
    },
  });
  for (const id of ['', 'abc', '-1', '1234567890', '1/2', '%31', '1.0'])
    assert.equal((await request(`/inciweb/publication/${id}`)).status, 400);
  for (const path of ['/', '/inciweb/index', '/inciweb/publication/123']) {
    for (const method of ['POST', 'HEAD', 'PUT', 'DELETE'])
      assert.equal((await request(path, method)).status, 405);
  }
  assert.equal(calls, 0);
});

test('InciWeb index preserves the fixed POST, caches for one hour and serves stale arrays', async () => {
  let clock = 0,
    calls = 0;
  const rows = [{ incident_id: '42', incident_title: 'Fire' }];
  const request = install({
    now: () => clock,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://inciweb.wildfire.gov/api/single-publication/');
      assert.equal(options.method, 'POST');
      assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
      assert.deepEqual(JSON.parse(options.body), { title: '' });
      if (calls > 1) throw new Error('offline');
      return Response.json(rows);
    },
  });
  assert.deepEqual((await request('/inciweb/index')).body, rows);
  clock = 3_599_999;
  assert.deepEqual((await request('/inciweb/index')).body, rows);
  assert.equal(calls, 1);
  clock++;
  const stale = await request('/inciweb/index');
  assert.deepEqual(stale.body, rows);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
});

test('publication timestamps, thirty-minute TTL and oldest-entry eviction', async () => {
  let clock = 0;
  const calls = [];
  const request = install({
    now: () => clock,
    fetchImpl: async (url) => {
      calls.push(url);
      return url.includes('/node/')
        ? incidentRedirect()
        : new Response(incidentHtml);
    },
  });
  const get = (id) =>
    request(`/inciweb/publication/${id}`, 'GET', `peer-${id}`);
  assert.deepEqual((await get(1)).body, incidentTimes);
  clock = 1_799_999;
  await get(1);
  assert.equal(calls.length, 2);
  clock++;
  await get(1);
  assert.equal(calls.length, 4);
  for (let id = 2; id <= 257; id++) assert.equal((await get(id)).status, 200);
  await get(2);
  assert.equal(calls.length, 516);
  await get(1);
  assert.equal(calls.length, 518);
  assert.equal(calls.at(-2), 'https://inciweb.wildfire.gov/node/1');
});

test('InciWeb index and publication reads enforce their smaller caps', async () => {
  for (const [path, cap] of [
    ['/inciweb/index', 4 * 1024 * 1024],
    ['/inciweb/publication/1', 2 * 1024 * 1024],
  ]) {
    const request = install({
      fetchImpl: async () =>
        new Response('{}', { headers: { 'Content-Length': String(cap + 1) } }),
    });
    assert.equal((await request(path)).status, 502);
  }
});

test('the per-client limit stops a loop while another client can read the cache', async () => {
  let calls = 0;
  const request = install({
    fetchImpl: async () => {
      calls++;
      return Response.json({ features: [] });
    },
  });
  for (let i = 0; i < 60; i++) assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 429);
  assert.equal((await request('/', 'GET', 'another-client')).status, 200);
  assert.equal(calls, 1);
});

test('publication redirects share a signal, cancel the redirect body and force HTTPS', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const calls = [];
    const redirect = new Response('redirect', {
      status,
      headers: {
        location: 'http://inciweb.wildfire.gov/incident/test-fire#details',
      },
    });
    const request = install({
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1 ? redirect : new Response(incidentHtml);
      },
    });
    assert.deepEqual(
      (await request('/inciweb/publication/42')).body,
      incidentTimes,
    );
    assert.equal(calls.length, 2);
    assert.equal(redirect.bodyUsed, true);
    assert.equal(calls[0].url, 'https://inciweb.wildfire.gov/node/42');
    assert.equal(calls[0].options.redirect, 'manual');
    assert.equal(
      calls[1].url,
      'https://inciweb.wildfire.gov/incident/test-fire',
    );
    assert.equal(calls[1].options.redirect, 'error');
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.equal(calls[0].options.signal, calls[1].options.signal);
  }
});

test('unsafe publication redirect locations fail before a second fetch', async () => {
  for (const location of [
    'https://evil.example/x',
    '/a/../x',
    '/x?q=1',
    '/x?',
    '/%2e%2e/x',
    '/a/b/c',
    '',
  ]) {
    let calls = 0;
    const request = install({
      fetchImpl: async () => {
        calls++;
        return new Response('redirect', { status: 301, headers: { location } });
      },
    });
    assert.equal((await request('/inciweb/publication/42')).status, 502);
    assert.equal(calls, 1);
  }
});

test('incident pages without valid timestamps fail closed and are not cached', async () => {
  for (const html of [
    '<html>No markers</html>',
    incidentHtml.replaceAll(/2026-[^"]+/g, 'invalid'),
  ]) {
    let calls = 0;
    const request = install({
      fetchImpl: async () => {
        calls++;
        return calls % 2 ? incidentRedirect() : new Response(html);
      },
    });
    assert.equal((await request('/inciweb/publication/42')).status, 502);
    assert.equal((await request('/inciweb/publication/42')).status, 502);
    assert.equal(calls, 4);
  }
});

test('direct 200 incident pages work, including one missing timestamp', async () => {
  for (const [html, expected] of [
    [incidentHtml, incidentTimes],
    [
      incidentHtml.replace('og:updated_time', 'unrelated'),
      { ...incidentTimes, changedMs: null },
    ],
    [
      incidentHtml.replace('Date of Origin', 'Unrelated'),
      { ...incidentTimes, createdMs: null },
    ],
  ]) {
    let calls = 0;
    const request = install({
      fetchImpl: async () => {
        calls++;
        return new Response(html);
      },
    });
    assert.deepEqual((await request('/inciweb/publication/42')).body, expected);
    assert.equal(calls, 1);
  }
});

test('publication HTML streams are capped at 2 MiB', async () => {
  let cancelled = false;
  const request = install({
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  assert.equal((await request('/inciweb/publication/42')).status, 502);
  assert.equal(cancelled, true);
});
