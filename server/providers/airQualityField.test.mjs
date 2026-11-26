import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { airQualityFieldProxy } from './airQualityField.js';

const FIXTURE = fileURLToPath(
  new URL('../../src/layers/airQuality/fixtures/field/', import.meta.url),
);

function harness(dir, preview = false) {
  let handler;
  const plugin = airQualityFieldProxy({ dir: () => dir });
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/air-quality/field');
        handler = fn;
      },
    },
  });
  return async (url, { method = 'GET', headers = {} } = {}) => {
    let status;
    let head = {};
    let body;
    let next = false;
    await handler(
      { method, url, headers },
      {
        setHeader(name, value) {
          head[name] = value;
        },
        writeHead(code, fields = {}) {
          status = code;
          head = { ...head, ...fields };
        },
        end(chunk) {
          body = chunk;
        },
      },
      () => {
        next = true;
      },
    );
    return { status, head, body, next };
  };
}
const json = (answer) => JSON.parse(String(answer.body));

test('without AIR_QUALITY_FIELD_DIR the field route says it is not configured', async () => {
  for (const preview of [false, true]) {
    const request = harness('', preview);
    const manifest = await request('/manifest');
    assert.equal(manifest.status, 200);
    assert.deepEqual(json(manifest), {
      unavailable: true,
      code: 'not_configured',
      reason: 'Model field not configured',
    });
    assert.equal((await request('/grid/global/000/pm25.u16')).status, 404);
  }
});

test('a configured folder is served: its manifest and its grids, nothing else', async () => {
  const request = harness(FIXTURE);
  const manifest = await request('/manifest');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.head['Cache-Control'], 'no-store');
  assert.deepEqual(
    json(manifest),
    JSON.parse(readFileSync(`${FIXTURE}manifest.json`, 'utf8')),
  );
  assert.equal(
    (await request('/grid/europe/024/aqi.u16?run=other')).status,
    409,
  );
  const grid = await request(
    `/grid/europe/024/aqi.u16?run=${encodeURIComponent(json(manifest).run)}`,
  );
  assert.equal(grid.status, 200);
  assert.equal(grid.head['Content-Type'], 'application/octet-stream');
  assert.ok(
    Buffer.from(grid.body).equals(readFileSync(`${FIXTURE}europe/024/aqi.u16`)),
  );
  assert.match(grid.head.ETag, /^"[^"]+"$/);
  const again = await request('/grid/europe/024/aqi.u16', {
    headers: { 'if-none-match': grid.head.ETag },
  });
  assert.equal(again.status, 304);
  for (const url of [
    '/grid/global/024/../../manifest.json',
    '/grid/global/24/pm25.u16',
    '/grid/asia/000/pm25.u16',
    '/grid/global/000/nh3.u16',
    '/grid/global/003/pm25.u16',
    '/manifest.json',
    '/other',
  ])
    assert.equal((await request(url)).status, 404, url);
  assert.equal((await request('/manifest', { method: 'POST' })).status, 405);
});

test('a folder that cannot be read answers unavailable, not an error page', async () => {
  const request = harness(`${FIXTURE}missing-folder`);
  const manifest = await request('/manifest');
  assert.equal(manifest.status, 200);
  assert.equal(json(manifest).unavailable, true);
  assert.equal(json(manifest).code, 'unavailable');
});
