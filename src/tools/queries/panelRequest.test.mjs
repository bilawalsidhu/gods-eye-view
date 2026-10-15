import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import {
  PANEL_CONCURRENT_REQUESTS,
  PANEL_PART_BYTES,
  PANEL_RESPONSE_LIMIT_BYTES,
} from './panelRequest.js';

const fromBase64 = (text) => Buffer.from(text, 'base64');
const KEY = 'panel-key-for-tests';
const gunzip = async (bytes) =>
  new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer(),
  );

function catalogWith(handler) {
  const requests = [];
  const fetchImpl = async (path, init) => {
    requests.push({ path, ...init });
    return handler(path, init);
  };
  return {
    requests,
    catalog: composeCatalog({
      tools: coreTools,
      services: {
        app: {
          baseUrl: 'http://localhost:4173/',
          fetch: fetchImpl,
          panelKey: KEY,
        },
      },
    }),
  };
}

test('panel_request is for the panel only', () => {
  const { catalog } = catalogWith(() => new Response('x'));
  assert.deepEqual(catalog.get('panel_request').ui, { visibility: ['app'] });
});

test('a small response returns whole, compressed when that helps', async () => {
  const text = 'body { color: red; }\n'.repeat(200);
  const { catalog, requests } = catalogWith(
    () =>
      new Response(text, {
        status: 200,
        headers: { 'content-type': 'text/css', 'set-cookie': 'a=b' },
      }),
  );
  const { data } = await catalog.call('panel_request', {
    key: KEY,
    path: '/panel/assets/style.css',
    headers: { Accept: 'text/css', Cookie: 'secret', 'X-Other': '1' },
  });
  assert.deepEqual(requests[0].headers, { Accept: 'text/css' });
  assert.equal(data.status, 200);
  assert.equal(data.encoding, 'gzip');
  assert.equal(data.nextOffset, undefined);
  assert.equal(data.headers['content-type'], 'text/css');
  assert.equal(data.headers['set-cookie'], undefined);
  const body = await gunzip(fromBase64(data.body));
  assert.equal(new TextDecoder().decode(body), text);
});

test('a large response comes in parts that join to the original', async () => {
  const bytes = new Uint8Array(PANEL_PART_BYTES * 2 + 10);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = (index * 7919) % 251;
  const { catalog } = catalogWith(
    () => new Response(bytes, { headers: { 'content-type': 'image/png' } }),
  );
  let { data } = await catalog.call('panel_request', {
    key: KEY,
    path: '/a.png',
  });
  assert.equal(data.encoding, 'identity');
  assert.equal(data.totalBytes, bytes.length);
  const parts = [fromBase64(data.body)];
  while (data.nextOffset !== undefined) {
    ({ data } = await catalog.call('panel_request', {
      key: KEY,
      id: data.id,
      offset: data.nextOffset,
    }));
    parts.push(fromBase64(data.body));
  }
  assert.equal(parts.length, 3);
  assert.deepEqual(new Uint8Array(Buffer.concat(parts)), bytes);
});

test('a request body and method pass through; settings and other sites do not', async () => {
  const { catalog, requests } = catalogWith(
    () => new Response('{}', { status: 201 }),
  );
  const { data } = await catalog.call('panel_request', {
    key: KEY,
    path: '/api/overpass',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from('{"a":1}').toString('base64'),
  });
  assert.equal(data.status, 201);
  assert.equal(new TextDecoder().decode(requests[0].body), '{"a":1}');
  for (const path of [
    '/api/setup/status',
    '/api/setup',
    '/api/%73etup/status',
    '//evil.example/x',
    '/\\evil.example/secret',
    '/\\/evil.example/secret',
    'http://evil.example/',
  ])
    await assert.rejects(
      catalog.call('panel_request', { key: KEY, path }),
      (error) => error.code === 'invalid_arguments',
      path,
    );
  await assert.rejects(
    catalog.call('panel_request', { key: KEY, id: 'unknown' }),
    (error) => error.code === 'invalid_arguments',
  );
  assert.equal(requests.length, 1);
});

test('the path is requested as the parser reads it, without following redirects', async () => {
  const { catalog, requests } = catalogWith(() => new Response('ok'));
  await catalog.call('panel_request', {
    key: KEY,
    key: KEY,
    path: '/panel/a/../b.js?x=1',
  });
  assert.equal(requests[0].path, '/panel/b.js?x=1');
  assert.equal(requests[0].redirect, 'manual');
  assert.ok(requests[0].signal instanceof AbortSignal);
});

test('a response larger than the panel may load is refused while reading', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const { catalog } = catalogWith(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            sent += chunk.length;
            controller.enqueue(chunk);
          },
        }),
      ),
  );
  await assert.rejects(
    catalog.call('panel_request', { key: KEY, path: '/huge' }),
    (error) => error.code === 'unavailable' && /too large/.test(error.message),
  );
  assert.ok(sent <= PANEL_RESPONSE_LIMIT_BYTES + 2 * chunk.length, `${sent}`);
});

test('large responses read in turn keep their own parts', async () => {
  const bodies = [1, 2].map((fill) =>
    new Uint8Array(PANEL_PART_BYTES + 5).fill(fill),
  );
  let index = 0;
  const { catalog } = catalogWith(
    () =>
      new Response(bodies[index++], {
        headers: { 'content-type': 'image/png' },
      }),
  );
  const first = (
    await catalog.call('panel_request', { key: KEY, path: '/a.png' })
  ).data;
  const second = (
    await catalog.call('panel_request', { key: KEY, path: '/b.png' })
  ).data;
  for (const [start, fill] of [
    [first, 1],
    [second, 2],
  ]) {
    const { data } = await catalog.call('panel_request', {
      key: KEY,
      id: start.id,
      offset: start.nextOffset,
    });
    assert.deepEqual([...fromBase64(data.body)], [1, 1, 1, 1, 1].fill(fill));
  }
});

test('a call without the panel key is refused before any request', async () => {
  const { catalog, requests } = catalogWith(() => new Response('ok'));
  for (const key of [undefined, '', 'wrong', `${KEY}x`, KEY.toUpperCase()])
    await assert.rejects(
      catalog.call('panel_request', {
        ...(key === undefined ? {} : { key }),
        path: '/panel/index.html',
      }),
      (error) => error.code === 'invalid_arguments',
      String(key),
    );
  await assert.rejects(
    catalog.call('panel_request', { id: 'held-elsewhere', offset: 0 }),
    (error) => error.code === 'invalid_arguments',
  );
  assert.equal(requests.length, 0);
});

test('without a panel key in its services the tool refuses every call', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      app: {
        baseUrl: 'http://localhost:4173/',
        fetch: async () => new Response('ok'),
      },
    },
  });
  await assert.rejects(
    catalog.call('panel_request', { key: '', path: '/panel/index.html' }),
    (error) => error.code === 'invalid_arguments',
  );
});

test('routes the panel never loads are refused in any case or encoding', async () => {
  const { catalog, requests } = catalogWith(() => new Response('ok'));
  for (const path of [
    '/API/setup/status',
    '/Api/Setup',
    '/api/realtime/token',
    '/API/REALTIME/token',
    '/api/openai/hud-summary',
    '/api/%4fpenai/hud-summary',
    '/mcp',
    '/MCP',
    // A dot after a mounted route still reaches it.
    '/mcp.json',
    '/MCP.json',
    '/api/setup.json',
    '/api/realtime.token',
    '/api/OpenAI.x/hud-summary',
    '/@fs/etc/passwd',
    '/@vite/client',
    '/%40fs/x',
    '/__open-in-editor?file=x',
  ])
    await assert.rejects(
      catalog.call('panel_request', { key: KEY, path }),
      (error) => error.code === 'invalid_arguments',
      path,
    );
  // Similar names the panel does load stay available.
  await catalog.call('panel_request', { key: KEY, path: '/api/setups-help' });
  await catalog.call('panel_request', { key: KEY, path: '/mcpx.json' });
  assert.deepEqual(
    requests.map((request) => request.path),
    ['/api/setups-help', '/mcpx.json'],
  );
});

test('requests past the limit wait their turn instead of failing', async () => {
  const gates = [];
  const { catalog, requests } = catalogWith(
    () =>
      new Promise((resolve) => gates.push(() => resolve(new Response('ok')))),
  );
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  // Two panels on one server, each sending as many requests as it may.
  const calls = Array.from({ length: PANEL_CONCURRENT_REQUESTS * 2 }, (_, n) =>
    catalog.call('panel_request', { key: KEY, path: `/panel/${n}.js` }),
  );
  await tick();
  assert.equal(requests.length, PANEL_CONCURRENT_REQUESTS);
  // Each finished request lets one waiting request start.
  for (let started = PANEL_CONCURRENT_REQUESTS; gates.length;) {
    gates.shift()();
    await tick();
    if (started < calls.length) {
      started += 1;
      assert.equal(requests.length, started);
    }
  }
  const results = await Promise.all(calls);
  assert.ok(results.every(({ data }) => data.status === 200));
});

test('a waiting request its caller cancels leaves the queue', async () => {
  const gates = [];
  const { catalog, requests } = catalogWith(
    () =>
      new Promise((resolve) => gates.push(() => resolve(new Response('ok')))),
  );
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const busy = Array.from({ length: PANEL_CONCURRENT_REQUESTS }, (_, n) =>
    catalog.call('panel_request', { key: KEY, path: `/panel/${n}.js` }),
  );
  const cancel = new AbortController();
  const waiting = catalog.call(
    'panel_request',
    { key: KEY, path: '/panel/cancelled.js' },
    { signal: cancel.signal },
  );
  const after = catalog.call('panel_request', {
    key: KEY,
    path: '/panel/after.js',
  });
  await tick();
  cancel.abort();
  await assert.rejects(waiting);
  gates.shift()();
  await tick();
  // The cancelled request never reached the server; the next one did.
  assert.equal(requests.at(-1).path, '/panel/after.js');
  while (gates.length) gates.shift()();
  await Promise.all([...busy, after]);
  assert.ok(
    !requests.some((request) => request.path === '/panel/cancelled.js'),
  );
});

test("one server's held responses are not readable through another's", async () => {
  const big = new Uint8Array(PANEL_PART_BYTES * 2).fill(7);
  const one = catalogWith(
    () => new Response(big, { headers: { 'content-type': 'image/png' } }),
  );
  const other = catalogWith(() => new Response('x'));
  const { data } = await one.catalog.call('panel_request', {
    key: KEY,
    path: '/big.png',
  });
  assert.ok(data.id);
  await assert.rejects(
    other.catalog.call('panel_request', {
      key: KEY,
      id: data.id,
      offset: data.nextOffset,
    }),
    (error) => error.code === 'invalid_arguments',
  );
  const rest = await one.catalog.call('panel_request', {
    key: KEY,
    id: data.id,
    offset: data.nextOffset,
  });
  assert.equal(rest.data.offset, data.nextOffset);
});
