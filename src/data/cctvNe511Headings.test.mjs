import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadRoadHeadings,
  joinRoadHeadings,
} from '../../server/providers/cctv/headings.js';
import { positionKey } from '../../server/providers/cctv/roadHeadings.js';
import {
  parseArgs,
  batches,
} from '../../scripts/precompute-ne511-headings.mjs';

const CAMERA = { id: 'ne511-148', lat: 41.22445, lon: -95.9759 };

/** Write a sidecar to a throwaway path and point the loader at it. */
function withSidecar(payload, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-ne511-headings-'));
  const file = path.join(dir, 'ne511_headings.json');
  fs.writeFileSync(
    file,
    typeof payload === 'string' ? payload : JSON.stringify(payload),
  );
  const previous = process.env.CCTV_NE511_HEADINGS_FILE;
  process.env.CCTV_NE511_HEADINGS_FILE = file;
  try {
    return run(file);
  } finally {
    if (previous === undefined) delete process.env.CCTV_NE511_HEADINGS_FILE;
    else process.env.CCTV_NE511_HEADINGS_FILE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('positionKey is stable at ~1 m and rejects unusable coordinates', () => {
  assert.equal(positionKey(CAMERA), '41.22445,-95.97590');
  // Float noise below the 5th decimal must not churn the table.
  assert.equal(
    positionKey({ lat: 41.224450001, lon: -95.9759 }),
    positionKey(CAMERA),
  );
  // A real move does change the key.
  assert.notEqual(
    positionKey({ lat: 41.2255, lon: -95.9759 }),
    positionKey(CAMERA),
  );
  assert.equal(positionKey({ lat: NaN, lon: 0 }), '');
  assert.equal(positionKey(null), '');
});

test('a missing or malformed sidecar means no headings, never an error', () => {
  const previous = process.env.CCTV_NE511_HEADINGS_FILE;
  process.env.CCTV_NE511_HEADINGS_FILE = path.join(
    os.tmpdir(),
    'gev-ne511-absent-sidecar.json',
  );
  try {
    assert.deepEqual(loadRoadHeadings(), {});
  } finally {
    if (previous === undefined) delete process.env.CCTV_NE511_HEADINGS_FILE;
    else process.env.CCTV_NE511_HEADINGS_FILE = previous;
  }
  assert.deepEqual(
    withSidecar('{ not json', () => loadRoadHeadings()),
    {},
  );
  assert.deepEqual(
    withSidecar({ schemaVersion: 1 }, () => loadRoadHeadings()),
    {},
  );
});

test('a valid sidecar replaces the id-hash prior with the road heading', () => {
  const entries = withSidecar(
    {
      schemaVersion: 2,
      cameras: { [positionKey(CAMERA)]: { status: 'ok', axisDeg: 77 } },
    },
    () => loadRoadHeadings(),
  );
  const source = { ...CAMERA, headingDeg: 157.5, headingConfidence: 'low' };
  joinRoadHeadings([source], entries);
  // The prior picks the nearer end of the axis.
  assert.equal(source.headingDeg, 77);
  // The axis is measured but its direction inferred, so the camera still
  // presents as a raw prior.
  assert.equal(source.headingConfidence, 'low');
});

test('a sidecar from the id-keyed schema is ignored rather than misread', () => {
  const entries = withSidecar(
    {
      schemaVersion: 1,
      cameras: {
        'ne511-148': {
          positionKey: positionKey(CAMERA),
          status: 'ok',
          axisDeg: 77,
          headingDeg: 257,
        },
      },
    },
    () => loadRoadHeadings(),
  );
  assert.deepEqual(entries, {});
});

test('a renumbered camera keeps its heading because the join is by position', () => {
  const entries = { [positionKey(CAMERA)]: { status: 'ok', axisDeg: 77 } };
  const renumbered = { ...CAMERA, id: 'ne511-659', headingDeg: 300 };
  joinRoadHeadings([renumbered], entries);
  assert.equal(renumbered.headingDeg, 257);
});

test('co-sited masts take their facing from their own titles', () => {
  const entries = { [positionKey(CAMERA)]: { status: 'ok', axisDeg: 90.3 } };
  const east = { ...CAMERA, name: 'I-80: Mile 440 EB', headingDeg: 260 };
  const west = { ...CAMERA, name: 'I-80: Mile 440 WB', headingDeg: 80 };
  joinRoadHeadings([east, west], entries);
  assert.equal(east.headingDeg, 90.3);
  assert.equal(west.headingDeg, 270.3);
});

test('a moved camera falls back to its prior instead of a stale bearing', () => {
  const entries = { '41.00000,-96.00000': { status: 'ok', axisDeg: 77 } };
  const source = { ...CAMERA, headingDeg: 157.5 };
  joinRoadHeadings([source], entries);
  assert.equal(source.headingDeg, 157.5);
});

test('only usable entries are applied', () => {
  const cases = [
    { status: 'no-road' },
    { status: 'ok', axisDeg: null },
    { status: 'ok' },
    undefined,
  ];
  for (const entry of cases) {
    const source = { ...CAMERA, headingDeg: 157.5 };
    joinRoadHeadings([source], { [positionKey(CAMERA)]: entry });
    assert.equal(source.headingDeg, 157.5, `entry ${JSON.stringify(entry)}`);
  }
  // A junk entries map is a no-op, not a throw.
  const source = { ...CAMERA, headingDeg: 157.5 };
  assert.doesNotThrow(() => joinRoadHeadings([source], null));
  assert.equal(source.headingDeg, 157.5);
});

test('applied headings are wrapped into [0,360)', () => {
  const source = { ...CAMERA, headingDeg: 250 };
  joinRoadHeadings([source], {
    [positionKey(CAMERA)]: { status: 'ok', axisDeg: -103 },
  });
  assert.equal(source.headingDeg, 257);
});

test('the shipped sidecar loads, keyed by position', () => {
  const previous = process.env.CCTV_NE511_HEADINGS_FILE;
  delete process.env.CCTV_NE511_HEADINGS_FILE;
  try {
    const root = path.resolve(import.meta.dirname, '../..');
    const entries = loadRoadHeadings(root);
    const keys = Object.keys(entries);
    assert.ok(keys.length > 300, `${keys.length} entries`);
    assert.ok(keys.every((key) => /^-?\d+\.\d{5},-?\d+\.\d{5}$/.test(key)));
  } finally {
    if (previous !== undefined) process.env.CCTV_NE511_HEADINGS_FILE = previous;
  }
});

test('the precompute CLI parses its flags and batches without mutating', () => {
  assert.deepEqual(parseArgs(['--limit', '16', '--force']).limit, 16);
  assert.equal(parseArgs(['--force']).force, true);
  assert.equal(parseArgs([]).force, false);
  assert.equal(parseArgs(['--out', 'x.json']).out, 'x.json');
  assert.equal(parseArgs([]).limit, Infinity);

  const items = [1, 2, 3, 4, 5];
  assert.deepEqual(batches(items, 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(items, [1, 2, 3, 4, 5]);
});
