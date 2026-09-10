import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createScreenshotSink } from '../scripts/shot-sink.mjs';

const run = promisify(execFile);
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

async function startSink(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gev-shot-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { server, token } = await createScreenshotSink({ out: root, ...options });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const send = ({ name = 'shot', headers = {}, body = dataUrl, method = 'POST', chunked = false } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent: false,
      path: `/save?name=${encodeURIComponent(name)}`, method,
      headers: { Origin: 'http://localhost:4173', Authorization: `Bearer ${token}`,
        ...(chunked ? {} : { 'Content-Length': Buffer.byteLength(body) }), ...headers },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
  return { root, send, server, token };
}

test('screenshot sink requires a local Host, matching Origin, and bearer token', async (t) => {
  const { root, send } = await startSink(t);
  assert.equal((await send({ headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await send({ headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await send({ headers: { Origin: '' } })).status, 403);
  assert.equal((await send({ headers: { Authorization: '' } })).status, 401);
  assert.equal((await send({ headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.deepEqual(await readdir(root), []);
  const preflight = await send({ method: 'OPTIONS', body: '', headers: { Authorization: '' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:4173');
  assert.equal((await send()).status, 201);
  assert.deepEqual(await readFile(path.join(root, 'shot.png')), png);
  assert.equal((await send()).status, 409);
});

test('screenshot sink rejects traversal, active content, malformed base64, and request overflow', async (t) => {
  const { root, send } = await startSink(t, { maxRequestBytes: 80 });
  assert.equal((await send({ name: '../escape' })).status, 400);
  assert.equal((await send({ body: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
  assert.equal((await send({ body: 'data:image/png;base64,PHNjcmlwdD4=' })).status, 400);
  assert.equal((await send({ body: dataUrl + '!!' })).status, 400);
  assert.equal((await send({ body: 'x'.repeat(100) })).status, 413);
  assert.equal((await send({ body: 'x'.repeat(100), chunked: true })).status, 413);
  assert.deepEqual(await readdir(root), []);
});

test('screenshot disk quota is serialized across writes and survives a new sink instance', async (t) => {
  const { root, send } = await startSink(t, { maxStoredBytes: png.length });
  const responses = await Promise.all([send({ name: 'one' }), send({ name: 'two' })]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 507]);
  assert.equal((await readdir(root)).length, 1);
  const { send: second } = await startSink(t, { out: root, maxFiles: 1 });
  assert.equal((await second({ name: 'three' })).status, 507);
});

test('QA and rendering scripts retain browser sandbox and same-origin protections', async () => {
  for (const directory of ['scripts', 'tools']) {
    for (const file of await readdir(new URL(`../${directory}/`, import.meta.url))) {
      if (!file.endsWith('.mjs')) continue;
      const source = await readFile(new URL(`../${directory}/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /--(?:no-sandbox|disable-setuid-sandbox|disable-web-security)/, file);
    }
  }
});

const bashTest = process.platform === 'win32' ? test.skip : test;
bashTest('dev-fresh refuses a busy port without terminating its owner', async () => {
  const source = await readFile(new URL('../scripts/dev-fresh.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bpkill\b|\bkill\s+-9\b/);
  assert.match(source, /--strictPort/);
  const start = source.indexOf('# Refuse an occupied port;');
  const end = source.indexOf('\necho "Clearing Vite cache', start);
  assert(start > 0 && end > start);
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-launcher-test-'));
  try {
    await writeFile(path.join(root, 'lsof'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await assert.rejects(run('bash', ['-c', source.slice(start, end)], {
      env: { PATH: `${root}:${process.env.PATH}`, PORT: '4173' },
    }), (error) => error.code === 1 && /already in use/.test(error.stderr));
    await writeFile(path.join(root, 'lsof'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    await run('bash', ['-c', source.slice(start, end)], { env: { PATH: `${root}:${process.env.PATH}`, PORT: '4173' } });
  } finally { await rm(root, { recursive: true, force: true }); }
});
