import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createIncidentStore,
  createIncidentsHandler,
  install,
  INCIDENTS_ROUTE,
  MAX_INCIDENT_BYTES,
  MAX_INCIDENTS_KEPT,
} from '../../server/providers/ollama/routes/incidents.js';

const DOC = (label = 'x') =>
  `<!doctype html><html><head><title>${label}</title></head><body>${label}</body></html>`;

function request(method, url, body) {
  const req = Readable.from(body == null ? [] : [Buffer.from(body)]);
  req.method = method;
  req.url = url;
  return req;
}

function response() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      this.body = chunk == null ? '' : String(chunk);
      this.done?.();
    },
  };
  res.finished = new Promise((resolve) => {
    res.done = resolve;
  });
  return res;
}

async function call(handler, method, url, body) {
  const res = response();
  await handler(request(method, url, body), res);
  await res.finished;
  const json = res.headers['content-type']?.includes('json')
    ? JSON.parse(res.body)
    : null;
  return { res, json };
}

function tempStore(t, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-incidents-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createIncidentStore({ dir, ...options });
}

test('install mounts the handler on the incidents route', () => {
  const routes = new Map();
  install({ use: (route, handler) => routes.set(route, handler) });
  assert.equal(typeof routes.get(INCIDENTS_ROUTE), 'function');
  assert.equal(MAX_INCIDENT_BYTES, 8 * 1024 * 1024);
  assert.equal(MAX_INCIDENTS_KEPT, 50);
});

test('POST saves a bundle and GET lists and serves it', async (t) => {
  const store = tempStore(t);
  const handler = createIncidentsHandler({ store });
  const at = Date.UTC(2026, 8, 16, 13, 4, 5);
  const saved = await call(
    handler,
    'POST',
    '/',
    JSON.stringify({ title: 'Runway Incursion!', at, html: DOC('one') }),
  );
  assert.equal(saved.res.statusCode, 201);
  assert.equal(saved.json.ok, true);
  assert.equal(saved.json.file, '20260916-130405-runway-incursion.html');
  assert.equal(saved.json.bytes, Buffer.byteLength(DOC('one')));
  assert.ok(existsSync(path.join(store.dir, saved.json.file)));

  const listed = await call(handler, 'GET', '/');
  assert.equal(listed.res.statusCode, 200);
  assert.equal(listed.json.count, 1);
  assert.equal(listed.json.incidents[0].file, saved.json.file);
  assert.equal(listed.json.incidents[0].bytes, saved.json.bytes);

  const served = await call(handler, 'GET', `/${saved.json.file}`);
  assert.equal(served.res.statusCode, 200);
  assert.match(served.res.headers['content-type'], /text\/html/);
  assert.equal(served.res.body, DOC('one'));
});

test('duplicate timestamps and titles get a numeric suffix', async (t) => {
  const store = tempStore(t);
  const handler = createIncidentsHandler({ store });
  const at = Date.UTC(2026, 8, 16, 13, 4, 5);
  const body = JSON.stringify({ title: 'same', at, html: DOC() });
  const first = await call(handler, 'POST', '/', body);
  const second = await call(handler, 'POST', '/', body);
  assert.equal(first.json.file, '20260916-130405-same.html');
  assert.equal(second.json.file, '20260916-130405-same-2.html');
});

test('rejects bodies over the cap, malformed JSON, and non-documents', async (t) => {
  const store = tempStore(t);
  const handler = createIncidentsHandler({ store, maxBytes: 200 });
  const big = await call(
    handler,
    'POST',
    '/',
    JSON.stringify({ title: 'big', html: DOC('y'.repeat(400)) }),
  );
  assert.equal(big.res.statusCode, 413);
  assert.equal(big.json.ok, false);

  const bad = await call(handler, 'POST', '/', '{not json');
  assert.equal(bad.res.statusCode, 400);

  const notHtml = await call(
    handler,
    'POST',
    '/',
    JSON.stringify({ title: 'x', html: '<script>alert(1)</script>' }),
  );
  assert.equal(notHtml.res.statusCode, 400);
  assert.equal(readdirSync(store.dir).length, 0);
});

test('keeps only the newest N bundles', async (t) => {
  const store = tempStore(t, { keep: 3 });
  const handler = createIncidentsHandler({ store });
  const base = Date.UTC(2026, 8, 16, 0, 0, 0);
  for (let i = 0; i < 5; i++) {
    const saved = await call(
      handler,
      'POST',
      '/',
      JSON.stringify({ title: `n${i}`, at: base + i * 60_000, html: DOC(i) }),
    );
    assert.equal(saved.res.statusCode, 201);
  }
  const names = readdirSync(store.dir).sort();
  assert.deepEqual(names, [
    '20260916-000200-n2.html',
    '20260916-000300-n3.html',
    '20260916-000400-n4.html',
  ]);
  const listed = await call(handler, 'GET', '/');
  assert.deepEqual(
    listed.json.incidents.map((entry) => entry.file),
    [
      '20260916-000400-n4.html',
      '20260916-000300-n3.html',
      '20260916-000200-n2.html',
    ],
  );
});

test('refuses path traversal, unknown files, and other methods', async (t) => {
  const store = tempStore(t);
  const handler = createIncidentsHandler({ store });
  for (const target of [
    '/../package.json',
    '/%2e%2e/package.json',
    '/nope.html',
    '/evil.txt',
  ]) {
    const { res } = await call(handler, 'GET', target);
    assert.equal(res.statusCode, 404, target);
  }
  const put = await call(handler, 'PUT', '/', '{}');
  assert.equal(put.res.statusCode, 405);
  assert.equal(put.res.headers.allow, 'GET, POST');
});

test('listing an absent directory is empty, not an error', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-incidents-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createIncidentStore({ dir: path.join(dir, 'missing') });
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.read('20260916-000000-x.html'), null);
});
