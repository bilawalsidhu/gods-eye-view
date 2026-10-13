import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGemHazard } from './hazard.js';

test('GEM point sampling respects georeferencing, no-data and coverage', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gem-hazard-'));
  try {
    const tags = [
      [256, 3, [2]],
      [257, 3, [1]],
      [258, 3, [64]],
      [259, 3, [1]],
      [273, 4, [300]],
      [277, 3, [1]],
      [278, 3, [1]],
      [339, 3, [3]],
      [33550, 12, [0.05, 0.05, 0]],
      [33922, 12, [0, 0, 0, 10, 50, 0]],
    ];
    const buffer = Buffer.alloc(316);
    buffer.write('II');
    buffer.writeUInt16LE(42, 2);
    buffer.writeUInt32LE(8, 4);
    buffer.writeUInt16LE(tags.length, 8);
    let extra = 150;
    tags.forEach(([tag, type, values], i) => {
      const offset = 10 + i * 12,
        size = type === 12 ? 8 : type === 4 ? 4 : 2;
      buffer.writeUInt16LE(tag, offset);
      buffer.writeUInt16LE(type, offset + 2);
      buffer.writeUInt32LE(values.length, offset + 4);
      let target = offset + 8;
      if (values.length * size > 4) {
        buffer.writeUInt32LE(extra, target);
        target = extra;
        extra += values.length * size;
      }
      values.forEach((value, j) =>
        type === 12
          ? buffer.writeDoubleLE(value, target + j * size)
          : type === 4
            ? buffer.writeUInt32LE(value, target + j * size)
            : buffer.writeUInt16LE(value, target + j * size),
      );
    });
    buffer.writeDoubleLE(0.25, 300);
    buffer.writeDoubleLE(-1e100, 308);
    const file = join(folder, 'fixture.tif');
    await writeFile(file, buffer);
    assert.deepEqual(await readGemHazard(49.99, 10.01, file), {
      pga: 0.25,
      resolutionDegrees: 0.05,
    });
    assert.equal(await readGemHazard(49.99, 10.06, file), null);
    assert.equal(await readGemHazard(51, 10.01, file), null);
    buffer.writeUInt16LE(5, 10 + 3 * 12 + 8);
    await writeFile(file, buffer);
    await assert.rejects(readGemHazard(49.99, 10.01, file), /Codifica/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
