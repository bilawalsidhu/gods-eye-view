import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer as createViteServer } from 'vite';
import { openAiRealtimeProxy } from '../vite.config.js';
import { createRequestSecurityMiddleware, requestSecurityPlugin } from '../server/requestSecurity.mjs';
import { createDebugLogWriter, redactDebugRecord } from '../server/debugLog.mjs';

function response() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(body) { this.body = body; this.emit('finish'); },
  });
}
function request(overrides = {}) {
  return { method: 'GET', url: '/api/realtime/token',
    socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:4173' }, ...overrides };
}
function admitted(req, guard = createRequestSecurityMiddleware()) {
  const res = response();
  let next = false;
  guard(req, res, () => { next = true; });
  return { next, res };
}

test('request guard rejects rebinding, LAN, proxy, and cross-origin requests before downstream work', () => {
  for (const req of [
    request({ headers: { host: 'attacker.example:4173' } }),
    request({ headers: { host: 'workstation.local:4173' } }),
    request({ headers: { host: 'localhost:4173', origin: 'https://attacker.example' } }),
    request({ headers: { host: 'localhost:4173', origin: 'http://localhost:4174' } }),
    request({ headers: { host: 'localhost:4173', 'x-forwarded-for': '127.0.0.1' } }),
    request({ headers: { host: 'localhost:4173', 'sec-fetch-site': 'same-site' } }),
    request({ headers: { host: 'localhost:4173', 'sec-fetch-mode': 'navigate' } }),
    request({ socket: { remoteAddress: '192.168.1.10' } }),
    request({ method: 'POST', headers: { host: 'localhost:4173', 'content-type': 'application/json' } }),
    request({ method: 'POST', headers: { host: 'localhost:4173', origin: 'http://localhost:4173', 'content-type': 'text/plain' } }),
  ]) {
    const result = admitted(req);
    assert.equal(result.next, false, JSON.stringify(req));
    assert([403, 415].includes(result.res.statusCode));
  }
});

test('same-origin image GET, JSON POST, and form-encoded Overpass POST remain usable', () => {
  for (const req of [request({ url: '/api/cctv/frame/test' }),
    request({ method: 'POST', headers: { host: 'localhost:4173', origin: 'http://localhost:4173', 'content-type': 'application/json' } }),
    request({ method: 'POST', url: '/api/overpass', headers: { host: 'localhost:4173', origin: 'http://localhost:4173', 'content-type': 'application/x-www-form-urlencoded' } }),
    request({ headers: { host: '[::1]:4173' }, socket: { remoteAddress: '::1' } }),
  ]) {
    const result = admitted(req);
    assert.equal(result.next, true);
    assert.match(result.res.headers['content-security-policy'], /sandbox/);
  }
});

test('API concurrency is released once on finish or disconnect', () => {
  const guard = createRequestSecurityMiddleware({ maxConcurrent: 1 });
  const first = admitted(request(), guard);
  assert.equal(first.next, true);
  assert.equal(admitted(request(), guard).res.statusCode, 429);
  first.res.emit('close');
  first.res.emit('finish');
  assert.equal(admitted(request(), guard).next, true);
  assert.equal(admitted(request(), guard).res.statusCode, 429);
});

test('both Vite hooks register early middleware without accidentally returning a post-hook', () => {
  const plugin = requestSecurityPlugin();
  assert.equal(plugin.enforce, 'pre');
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    let installed;
    assert.equal(plugin[hook]({ middlewares: { use(fn) { installed = fn; return () => {}; } } }), undefined);
    assert.equal(admitted(request({ headers: { host: 'evil.example' } }), installed).res.statusCode, 403);
  }
});

test('Vite rejects hostile requests before a real token route reaches its provider', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ value: 'test-ephemeral-secret' }));
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-provider-key';
  t.after(() => {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  });
  const vite = await createViteServer({ configFile: false, envFile: false,
    plugins: [requestSecurityPlugin(), openAiRealtimeProxy()],
    server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => vite.close());
  const server = http.createServer(vite.middlewares);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const send = (overrides = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', agent: false,
      path: '/api/realtime/token', ...overrides,
      headers: { 'content-length': '2', ...overrides.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', (error) => reject(new Error(JSON.stringify(overrides), { cause: error })));
    req.end('{}');
  });
  for (const headers of [
    { host: 'evil.example', origin: 'http://evil.example', 'content-type': 'application/json' },
    { origin: 'https://evil.example', 'content-type': 'text/plain' },
    { origin, 'content-type': 'text/plain' },
    { 'content-type': 'application/json' },
    { origin, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.1' },
  ]) {
    assert([403, 415].includes((await send({ headers })).status));
    assert([403, 415].includes((await send({ path: '/API/REALTIME/TOKEN', headers })).status));
  }
  assert.equal((await send({ method: 'GET' })).status, 405);
  assert.equal(globalThis.fetch.mock.calls.length, 0);
  const valid = await send({ headers: { origin, 'content-type': 'application/json' } });
  assert.equal(valid.status, 200);
  assert.equal(JSON.parse(valid.body).value, 'test-ephemeral-secret');
  assert.match(valid.headers['content-security-policy'], /sandbox/);
  assert.equal(globalThis.fetch.mock.calls.length, 1);
});

test('server-side redaction covers structured secrets, strings, images, and excessive nesting', () => {
  const result = redactDebugRecord({ api_key: 'CANARY', nested: { token: 'CANARY',
    text: 'Bearer CANARY data:image/png;base64,AAAA',
    message: 'sk-' + 'a'.repeat(30) }, images: ['data:image/jpeg;base64,AAAA'] });
  assert(!JSON.stringify(result).includes('CANARY'));
  assert(!JSON.stringify(result).includes('base64'));
  assert(!JSON.stringify(result).includes('a'.repeat(30)));
});

test('debug storage is permission-restricted, serialized, and bounded across appends', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-log-test-'));
  let file;
  try {
    const write = createDebugLogWriter({ tempRoot: root, maxBytes: 600, onCreated: (p) => { file = p; } });
    await Promise.all([write({ message: 'first', api_key: 'CANARY' }), write({ message: 'second' })]);
    assert.equal((await readFile(file, 'utf8')).split('\n').filter(Boolean).length, 2);
    assert(!(await readFile(file, 'utf8')).includes('CANARY'));
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(write({ message: 'x'.repeat(1000) }), /full/);
    assert((await stat(file)).size <= 600);
    assert.equal((await readdir(root)).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed log permission restriction never writes a record', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-log-test-'));
  try {
    const write = createDebugLogWriter({ tempRoot: root, harden: () => false });
    await assert.rejects(write({ message: 'CANARY' }), /permissions/);
    await assert.rejects(write({ message: 'CANARY' }), /unavailable/);
    const [directory] = await readdir(root);
    assert.equal((await stat(path.join(root, directory, 'realtime-conversations.jsonl'))).size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
