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
import { SCENE_DOCUMENT_LIMITS } from '../director/document.js';

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

test('a UTF-8 BOM scene exports like the same scene without BOM (Director import accepts both)', () => {
  const d = dir();
  try {
    const body = Buffer.from(JSON.stringify(doc(one)));
    const plain = join(d, 'plain.json');
    const bom = join(d, 'bom.json');
    writeFileSync(plain, body);
    writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
    const a = spawnSync(process.execPath, argsFor(plain, join(d, 'a.usda')), {
      encoding: 'utf8',
    });
    const b = spawnSync(process.execPath, argsFor(bom, join(d, 'b.usda')), {
      encoding: 'utf8',
    });
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.deepEqual(
      readFileSync(join(d, 'b.usda')),
      readFileSync(join(d, 'a.usda')),
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('the input file size limit includes the UTF-8 BOM', () => {
  const d = dir();
  try {
    const input = join(d, 'scene.json');
    const output = join(d, 'camera.usda');
    const scene = JSON.stringify(doc(one)).padEnd(
      SCENE_DOCUMENT_LIMITS.bytes,
      ' ',
    );
    writeFileSync(input, '\uFEFF' + scene);
    const result = spawnSync(process.execPath, argsFor(input, output), {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exceeds 5 MiB/);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

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
