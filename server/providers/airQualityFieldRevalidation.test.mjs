import assert from 'node:assert/strict';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { airQualityFieldProxy } from './airQualityField.js';
import { readFieldManifest } from '../../src/layers/airQuality/field.js';

const FIXTURE = fileURLToPath(
  new URL('../../src/layers/airQuality/fixtures/field/', import.meta.url),
);

function harness(dir) {
  let handler;
  const plugin = airQualityFieldProxy({ dir: () => dir });
  plugin.configureServer({
    middlewares: {
      use(_p, fn) {
        handler = fn;
      },
    },
  });
  return async (url, { method = 'GET', headers = {} } = {}) => {
    let status;
    let head = {};
    let body;
    await handler(
      { method, url, headers },
      {
        setHeader(n, v) {
          head[n] = v;
        },
        writeHead(code, fields = {}) {
          status = code;
          head = { ...head, ...fields };
        },
        end(chunk) {
          body = chunk;
        },
      },
      () => {},
    );
    return { status, head, body };
  };
}
const fresh = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aq-field-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
};

test('grid revalidation', async () => {
  const dir = fresh();
  try {
    const file = path.join(dir, 'global', '000', 'pm25.u16');
    const request = harness(dir);
    const first = await request('/grid/global/000/pm25.u16');
    assert.equal(first.status, 200);
    const original = statSync(file);
    // Correct the grid in place, keeping the modification time (copy that
    // preserves timestamps, or a rewrite within the same second).
    const changed = Buffer.from(first.body);
    changed[0] ^= 0xff;
    writeFileSync(file, changed);
    utimesSync(file, original.atime, original.mtime);
    const again = await request('/grid/global/000/pm25.u16', {
      headers: { 'if-modified-since': original.mtime.toUTCString() },
    });
    assert.equal(
      again.status,
      200,
      'changed bytes must not be revalidated as 304',
    );
    assert.deepEqual(Buffer.from(again.body), changed);
    const withOldTag = await request('/grid/global/000/pm25.u16', {
      headers: { 'if-none-match': first.head.ETag },
    });
    assert.equal(withOldTag.status, 200);
    assert.notEqual(withOldTag.head.ETag, first.head.ETag);
    assert.deepEqual(Buffer.from(withOldTag.body), changed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
