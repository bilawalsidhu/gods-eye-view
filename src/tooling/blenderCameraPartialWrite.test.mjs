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
  'a failed write leaves no partial stage and a retry succeeds',
  { skip: process.platform === 'win32' },
  () => {
    const d = dir();
    try {
      const input = join(d, 'scene.json');
      writeFileSync(
        input,
        JSON.stringify(
          doc([{ id: 'a', durationSec: 60, holdSec: 0, camera: pose() }]),
        ),
      );
      const out = join(d, 'o.usda');
      // RLIMIT_FSIZE (32 KiB) stands in for a full disk: write() fails with EFBIG after a prefix.
      const r = spawnSync(
        '/bin/sh',
        [
          '-c',
          'ulimit -f 64; exec "$0" "$@"',
          process.execPath,
          ...argsFor(input, out),
        ],
        { encoding: 'utf8' },
      );
      assert.equal(r.status, 1, r.stderr);
      assert.equal(
        existsSync(out),
        false,
        'truncated stage left at the final path',
      );
      const retry = spawnSync(process.execPath, argsFor(input, out), {
        encoding: 'utf8',
      });
      assert.equal(retry.status, 0, retry.stderr);
      assert.ok(readFileSync(out, 'utf8').trimEnd().endsWith('}'));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  },
);
