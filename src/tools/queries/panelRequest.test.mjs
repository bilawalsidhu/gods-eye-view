import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import {
  PANEL_PART_BYTES,
  PANEL_RESPONSE_LIMIT_BYTES,
} from './panelRequest.js';

const fromBase64 = (text) => Buffer.from(text, 'base64');
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
        app: { baseUrl: 'http://localhost:4173/', fetch: fetchImpl },
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
  let { data } = await catalog.call('panel_request', { path: '/a.png' });
  assert.equal(data.encoding, 'identity');
  assert.equal(data.totalBytes, bytes.length);
  const parts = [fromBase64(data.body)];
  while (data.nextOffset !== undefined) {
    ({ data } = await catalog.call('panel_request', {
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
    path: '/api/openai/hud-summary',
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
      catalog.call('panel_request', { path }),
      (error) => error.code === 'invalid_arguments',
      path,
    );
  await assert.rejects(
    catalog.call('panel_request', { id: 'unknown' }),
    (error) => error.code === 'invalid_arguments',
  );
  assert.equal(requests.length, 1);
});

test('the path is requested as the parser reads it, without following redirects', async () => {
  const { catalog, requests } = catalogWith(() => new Response('ok'));
  await catalog.call('panel_request', { path: '/panel/a/../b.js?x=1' });
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
    catalog.call('panel_request', { path: '/huge' }),
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
  const first = (await catalog.call('panel_request', { path: '/a.png' })).data;
  const second = (await catalog.call('panel_request', { path: '/b.png' })).data;
  for (const [start, fill] of [
    [first, 1],
    [second, 2],
  ]) {
    const { data } = await catalog.call('panel_request', {
      id: start.id,
      offset: start.nextOffset,
    });
    assert.deepEqual([...fromBase64(data.body)], [1, 1, 1, 1, 1].fill(fill));
  }
});
