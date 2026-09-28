import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import h5wasm from 'h5wasm/node';
import {
  decodeFireGrid,
  fixedGridToLatLon,
} from '../../server/providers/goes/fireGrid.js';
import {
  FIXTURE_AREA_OFFSET,
  FIXTURE_AREA_SCALE,
  FIXTURE_PROJECTION,
  FIXTURE_SCAN_END,
  FIXTURE_SCAN_START,
  FIXTURE_TEMP_OFFSET,
  FIXTURE_TEMP_SCALE,
  writeGoesFireGranule,
} from './goesFireFixture.mjs';

test('the ABI fixed grid inverts to geographic coordinates', () => {
  // Disk centre: the sub-satellite point, straight below the projection origin.
  const centre = fixedGridToLatLon(0, 0, FIXTURE_PROJECTION);
  assert.ok(Math.abs(centre.lat) < 1e-9);
  assert.ok(Math.abs(centre.lon + 75) < 1e-9);
  // Large scan angles leave the Earth entirely (geostationary limb).
  assert.equal(fixedGridToLatLon(0.2, 0.2, FIXTURE_PROJECTION), null);
});

test('FDCF granules decode detections with scaled telemetry and quality flags', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goes-fdcf-test-'));
  const granule = path.join(directory, 'granule.nc');
  try {
    await writeGoesFireGranule(granule);
    const grid = await decodeFireGrid(
      new Uint8Array(await fs.readFile(granule)),
    );

    assert.equal(grid.scanStartIso, FIXTURE_SCAN_START);
    assert.equal(grid.scanEndIso, FIXTURE_SCAN_END);
    assert.equal(grid.lon0, -75);
    // Only the two positive Power pixels are fires; the -9 fill is not.
    assert.equal(grid.detections.length, 2);

    const [first, second] = grid.detections;
    assert.equal(first.frp, 10.5);
    assert.equal(first.mask, 30);
    assert.equal(first.dqf, 0);
    assert.equal(first.night, true);
    // Temp at that pixel is the fill value, so no temperature is reported.
    assert.equal(first.tempK, null);
    assert.ok(Number.isFinite(first.lat) && Number.isFinite(first.lon));

    assert.equal(second.frp, 3.25);
    assert.equal(second.mask, 33);
    assert.equal(second.dqf, 2);
    assert.equal(second.night, false);
    assert.ok(
      Math.abs(
        second.tempK - (800 * FIXTURE_TEMP_SCALE + FIXTURE_TEMP_OFFSET),
      ) < 1e-9,
    );
    assert.ok(
      Math.abs(
        second.areaM2 - (1500 * FIXTURE_AREA_SCALE + FIXTURE_AREA_OFFSET),
      ) < 1e-6,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a granule without the Power dataset is rejected rather than decoded as empty', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goes-fdcf-test-'));
  const granule = path.join(directory, 'granule.nc');
  try {
    await h5wasm.ready;
    const file = new h5wasm.File(granule, 'w');
    file.create_dataset({
      name: 'Mask',
      data: Int16Array.from([30]),
      shape: [1],
      dtype: '<h',
    });
    file.close();
    await assert.rejects(
      decodeFireGrid(new Uint8Array(await fs.readFile(granule))),
      /no Power dataset/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
