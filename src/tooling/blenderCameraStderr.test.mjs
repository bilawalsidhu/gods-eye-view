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

const oneLineNoControl = (stderr) => {
  assert.equal(stderr.at(-1), 0x0a, 'ends with one newline');
  const body = stderr.subarray(0, stderr.length - 1);
  assert.equal(
    body.includes(0x0a),
    false,
    'diagnostic split over several lines',
  );
  assert.equal(
    /[\x00-\x1f\x7f-\x9f]/.test(body.toString('utf8')),
    false,
    'raw control byte in stderr',
  );
};

test('validator diagnostics from document field names are one line without raw control bytes', () => {
  const d = dir();
  try {
    const input = join(d, 'scene.json');
    writeFileSync(input, JSON.stringify(doc(one, { 'x\ty\nz': 1 })));
    const r = spawnSync(process.execPath, argsFor(input, join(d, 'o.usda')));
    assert.equal(r.status, 1);
    assert.match(String(r.stderr), /unsupported field/);
    assert.ok(String(r.stderr).includes('x\\x09y\\x0az'));
    oneLineNoControl(r.stderr);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('exporter diagnostics with a shot ID are one line without raw control bytes', () => {
  const d = dir();
  try {
    const input = join(d, 'scene.json');
    writeFileSync(
      input,
      JSON.stringify(
        doc([
          { id: 'a', durationSec: 0.25, holdSec: 0, camera: pose() },
          { id: 'b\tc', durationSec: 0.25, holdSec: 0, camera: pose() },
          { id: 'd', durationSec: 1.5, holdSec: 0, camera: pose() },
        ]),
      ),
    );
    const r = spawnSync(
      process.execPath,
      argsFor(input, join(d, 'o.usda'), '1'),
    );
    assert.equal(r.status, 1);
    assert.match(String(r.stderr), /has no sampled frame/);
    assert.ok(String(r.stderr).includes('b\\x09c'));
    oneLineNoControl(r.stderr);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
