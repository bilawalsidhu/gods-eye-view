// GEV_DATA_DIR moves what the app writes (the saved .env, .gev-cache,
// .gev-logs) out of the repo root, so the Docker image can keep its code
// read-only. Unset, nothing moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dataDir } from '../server/providers/common/data-dir.js';

test('dataDir is the fallback unless GEV_DATA_DIR is set', () => {
  assert.equal(dataDir('/repo', {}), '/repo', 'unset keeps today\'s repo-root behaviour');
  assert.equal(dataDir('/repo', { GEV_DATA_DIR: '' }), '/repo', 'empty is unset');
  assert.equal(dataDir('/repo', { GEV_DATA_DIR: '   ' }), '/repo', 'blank is unset');
  assert.equal(dataDir('/repo', { GEV_DATA_DIR: '/data' }), '/data', 'set moves it');
  assert.equal(
    dataDir('/repo', { GEV_DATA_DIR: 'rel/dir' }),
    path.resolve('rel/dir'),
    'a relative value is resolved, never joined onto the repo',
  );
  assert.equal(dataDir(undefined, {}), process.cwd(), 'the default fallback is the working directory');
});

function request(body) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = {
    host: 'localhost:4173',
    origin: 'http://localhost:4173',
    'content-type': 'application/json',
  };
  req.socket = { remoteAddress: '127.0.0.1' };
  req.destroy = () => {};
  queueMicrotask(() => {
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
  return req;
}

async function saveKey(sourceRoot) {
  delete process.env.OPENAI_API_KEY;
  const { keySetupEndpoint } = await import('../server/standalone/key-setup.js');
  const handlers = new Map();
  const restarts = [];
  keySetupEndpoint({ sourceRoot }).configureServer({
    middlewares: { use: (route, handler) => handlers.set(route, handler) },
    restart: async () => restarts.push(true),
  });
  return await new Promise((resolve) => {
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); },
    };
    handlers.get('/api/setup/keys')(request({ OPENAI_API_KEY: 'sk-testvalue1234567890' }), res);
  });
}

test('Provider Settings saves .env in the repo root when GEV_DATA_DIR is unset', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-root-'));
  const saved = process.env.GEV_DATA_DIR;
  delete process.env.GEV_DATA_DIR;
  try {
    const { status } = await saveKey(root);
    assert.equal(status, 200);
    assert.match(readFileSync(path.join(root, '.env'), 'utf8'), /^OPENAI_API_KEY=/m);
  } finally {
    if (saved !== undefined) process.env.GEV_DATA_DIR = saved;
    delete process.env.OPENAI_API_KEY;
    rmSync(root, { recursive: true, force: true });
  }
});

test('Provider Settings saves .env atomically inside GEV_DATA_DIR, not the code directory', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-root-'));
  const data = mkdtempSync(path.join(tmpdir(), 'gev-data-'));
  const saved = process.env.GEV_DATA_DIR;
  process.env.GEV_DATA_DIR = data;
  try {
    const { status, body } = await saveKey(root);
    assert.equal(status, 200, JSON.stringify(body));
    assert.match(readFileSync(path.join(data, '.env'), 'utf8'), /^OPENAI_API_KEY=/m);
    assert.equal(existsSync(path.join(root, '.env')), false, 'nothing is written beside the code');
    assert.deepEqual(
      readdirSync(data).filter((name) => name.endsWith('.tmp')),
      [],
      'the temp file was renamed into place, in the same directory',
    );
    if (process.platform !== 'win32') {
      assert.equal(statSync(path.join(data, '.env')).mode & 0o777, 0o600, 'the credential file stays private');
    }
  } finally {
    if (saved === undefined) delete process.env.GEV_DATA_DIR;
    else process.env.GEV_DATA_DIR = saved;
    delete process.env.OPENAI_API_KEY;
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});
