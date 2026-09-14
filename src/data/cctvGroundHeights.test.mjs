import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  joinGroundHeights,
  loadGroundHeights,
} from '../../server/providers/cctv/groundHeights.js';
import { poseHash } from './cctvFootprint.js';

const source = (over = {}) => ({
  id: 'cam-1',
  lat: 30.2672,
  lon: -97.7431,
  headingDeg: 90,
  pitchDeg: -24,
  fovDeg: 56,
  rangeM: 210,
  mountHeightM: 12,
  ...over,
});

test('a shipped entry attaches only while the nominal pose still matches', () => {
  const s = source();
  const entry = {
    status: 'ok',
    poseHash: poseHash(s),
    mountGroundM: 151.2,
    supports: { bl: 150.1, bm: 149.9, br: 155.5, tl: null, tm: 'x' },
  };
  const [joined] = joinGroundHeights([s], { 'cam-1': entry });
  assert.deepEqual(joined.groundHeights, {
    poseHash: entry.poseHash,
    mountGroundM: 151.2,
    supports: { bl: 150.1, bm: 149.9, br: 155.5 },
  });

  const moved = source({ lat: 30.2673 });
  const [notJoined] = joinGroundHeights([moved], { 'cam-1': entry });
  assert.equal(
    notJoined.groundHeights,
    undefined,
    'a moved camera loses the shipped value',
  );

  const [missed] = joinGroundHeights([source()], {
    'cam-1': { ...entry, status: 'miss', mountGroundM: null },
  });
  assert.equal(missed.groundHeights, undefined, 'a miss ships nothing');
  assert.deepEqual(
    joinGroundHeights([source()], null)[0].groundHeights,
    undefined,
  );
});

test('the sidecar loads from the source root and tolerates a missing or malformed file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-heights-'));
  fs.mkdirSync(path.join(dir, 'config'));
  assert.deepEqual(loadGroundHeights(dir), {}, 'missing file');
  const file = path.join(dir, 'config', 'cctv_ground_heights.json');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(loadGroundHeights(dir), {}, 'malformed file');
  fs.writeFileSync(
    file,
    JSON.stringify({ schemaVersion: 1, cameras: { a: { status: 'ok' } } }),
  );
  assert.deepEqual(loadGroundHeights(dir), { a: { status: 'ok' } });
});
