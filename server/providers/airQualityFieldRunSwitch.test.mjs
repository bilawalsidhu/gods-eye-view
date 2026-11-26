import assert from 'node:assert/strict';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { airQualityFieldProxy } from './airQualityField.js';

const FIXTURE = fileURLToPath(
  new URL('../../src/layers/airQuality/fixtures/field/', import.meta.url),
);

function harness(dir) {
  let handler;
  airQualityFieldProxy({ dir: () => dir }).configureServer({
    middlewares: {
      use(_path, fn) {
        handler = fn;
      },
    },
  });
  return async (url) => {
    let status;
    let body;
    await handler(
      { method: 'GET', url, headers: {} },
      {
        setHeader() {},
        writeHead(code) {
          status = code;
        },
        end(chunk) {
          body = chunk;
        },
      },
      () => {},
    );
    return { status, body };
  };
}

test('a current symlink switched mid-request still serves one run', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aq-field-runs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Two runs side by side; `current` points at the first.
  const runA = path.join(root, 'run-a');
  const runB = path.join(root, 'run-b');
  cpSync(FIXTURE, runA, { recursive: true });
  cpSync(FIXTURE, runB, { recursive: true });
  const manifestB = JSON.parse(
    readFileSync(path.join(runB, 'manifest.json'), 'utf8'),
  );
  manifestB.run = `${manifestB.run}-b`;
  writeFileSync(path.join(runB, 'manifest.json'), JSON.stringify(manifestB));
  const grid = 'europe/024/aqi.u16';
  const bytesA = readFileSync(path.join(runA, grid));
  // The second run's grid differs in every byte.
  writeFileSync(
    path.join(runB, grid),
    Buffer.from(bytesA.map((byte) => byte ^ 0xff)),
  );
  const current = path.join(root, 'current');
  symlinkSync(runA, current);
  const runAName = JSON.parse(
    readFileSync(path.join(runA, 'manifest.json'), 'utf8'),
  ).run;

  // Switch `current` to the second run right after the first run's manifest
  // is opened: between the request's manifest check and its grid read.
  const open = fsPromises.open;
  let switched = false;
  t.mock.method(fsPromises, 'open', async (file, ...rest) => {
    const handle = await open(file, ...rest);
    if (!switched && String(file).endsWith('manifest.json')) {
      switched = true;
      const next = path.join(root, 'next');
      symlinkSync(runB, next);
      renameSync(next, current);
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const answer = await harness(current)(
    `/grid/${grid}?run=${encodeURIComponent(runAName)}`,
  );
  assert.equal(switched, true);
  assert.equal(answer.status, 200);
  assert.deepEqual(Buffer.from(answer.body), bytesA);
  // The next request reads the new run, and refuses the old one's grids.
  const after = await harness(current)(
    `/grid/${grid}?run=${encodeURIComponent(runAName)}`,
  );
  assert.equal(after.status, 409);
});
