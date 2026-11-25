import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const cli = fileURLToPath(
  new URL('../../tools/export-blender-camera.mjs', import.meta.url),
);
const pose = (c = {}) => ({
  lat: 0,
  lon: 0,
  alt: 10,
  heading: 0,
  pitch: 0,
  roll: 0,
  ...c,
});
const doc = (shots, extra = {}) => ({
  version: 6,
  scenes: [{ id: 'scene', title: 'Synthetic', shots, ...extra }],
});
const one = [{ id: 'a', durationSec: 1, holdSec: 0, camera: pose() }];
const argsFor = (input, output, fps = '30') => [
  cli,
  '--input',
  input,
  '--output',
  output,
  '--origin',
  '0,0,0',
  '--fps',
  fps,
  '--width',
  '1920',
  '--height',
  '1080',
  '--horizontal-fov-deg',
  '60',
];
const dir = () => mkdtempSync(join(tmpdir(), 'gev-camera-repro-'));

test(
  'a FIFO --input without a writer is rejected as non-regular instead of hanging',
  { skip: process.platform === 'win32' },
  () => {
    const d = dir();
    try {
      const fifo = join(d, 'scene.json');
      execFileSync('mkfifo', [fifo]);
      const out = join(d, 'out.usda');
      const r = spawnSync(process.execPath, argsFor(fifo, out), {
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.equal(
        r.signal,
        null,
        'CLI hung in open() and was killed by the timeout',
      );
      assert.equal(r.status, 1);
      assert.match(r.stderr, /regular file/);
      assert.equal(existsSync(out), false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  },
);
