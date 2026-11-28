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

test('manifest UTF8 BOM', async () => {
  const dir = fresh();
  try {
    const file = path.join(dir, 'manifest.json');
    const plain = readFileSync(file);
    const request = harness(dir);
    const a = JSON.parse(String((await request('/manifest')).body));
    writeFileSync(
      file,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]),
    );
    const b = JSON.parse(String((await harness(dir)('/manifest')).body));
    assert.equal(
      b.unavailable,
      undefined,
      'BOM manifest must not be unavailable',
    );
    assert.equal(readFieldManifest(b).run, readFieldManifest(a).run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
