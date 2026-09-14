import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MASK_WATER,
  MASK_LAND,
  MASK_COASTAL,
  MASK_WIDTH,
  MASK_HEIGHT,
  wrapLon,
  packMaskStates,
  buildMaskFileBuffer,
  decodeMaskBuffer,
  maskStateAt,
} from './landSeaMaskCodec.js';

test('mask constants match the frozen asset contract', () => {
  assert.equal(MASK_WATER, 0);
  assert.equal(MASK_LAND, 1);
  assert.equal(MASK_COASTAL, 2);
  assert.equal(MASK_WIDTH, 2880);
  assert.equal(MASK_HEIGHT, 1440);
});

test('wrapLon normalizes into [-180, 180)', () => {
  assert.equal(wrapLon(0), 0);
  assert.equal(wrapLon(181), -179);
  assert.equal(wrapLon(-181), 179);
  assert.equal(wrapLon(180), -180);
  assert.equal(wrapLon(-180), -180);
  assert.ok(Math.abs(wrapLon(-540.06) - 179.94) < 1e-9);
  assert.equal(wrapLon(720), 0);
});

test('pack + build + decode round-trips a random state grid exactly', () => {
  const width = 16;
  const height = 8;
  const states = new Uint8Array(width * height);
  let seed = 12345;
  for (let i = 0; i < states.length; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    states[i] = seed % 3; // 0|1|2 only — 3 is reserved
  }
  // Direct packing contract: 4 cells/byte, LSB-first, 2 bits each.
  const packed = packMaskStates(states);
  assert.equal(packed.length, Math.ceil((width * height) / 4));
  assert.equal(packed[0], states[0] | (states[1] << 2) | (states[2] << 4) | (states[3] << 6));

  const file = buildMaskFileBuffer(states, width, height);
  assert.equal(file.byteLength, 16 + Math.ceil((width * height) / 4));
  const mask = decodeMaskBuffer(file);
  assert.equal(mask.width, width);
  assert.equal(mask.height, height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      // Grid coordinates: row 0 = lat band [-90, ...), each cell 1/8 deg is
      // only true for the production dims; here address cells directly via
      // the lat/lon that maps to (row, col) under an 8-cells-per-degree grid
      // scaled to this tiny mask: use the raw indexer through maskStateAt by
      // constructing lat/lon for a 16x8 grid (45 deg/col, 22.5 deg/row).
      const lat = -90 + (row + 0.5) * (180 / height);
      const lon = -180 + (col + 0.5) * (360 / width);
      assert.equal(maskStateAt(mask, lat, lon), states[row * width + col]);
    }
  }
});

test('decodeMaskBuffer rejects bad magic, version, dims, and truncation', () => {
  const good = buildMaskFileBuffer(new Uint8Array(16), 8, 2);
  assert.ok(decodeMaskBuffer(good));

  const badMagic = good.slice(0);
  new Uint8Array(badMagic)[0] = 0x58;
  assert.throws(() => decodeMaskBuffer(badMagic), /magic/i);

  const badVersion = good.slice(0);
  new DataView(badVersion).setUint16(4, 9, true);
  assert.throws(() => decodeMaskBuffer(badVersion), /version/i);

  const truncated = good.slice(0, good.byteLength - 1);
  assert.throws(() => decodeMaskBuffer(truncated), /length|truncat/i);

  const zeroDims = good.slice(0);
  new DataView(zeroDims).setUint32(8, 0, true);
  assert.throws(() => decodeMaskBuffer(zeroDims), /dimension|width/i);
});

test('maskStateAt handles the poles, the dateline column, and out-of-range longitudes', () => {
  const width = 4;
  const height = 4;
  const states = new Uint8Array(width * height);
  states[0] = MASK_LAND; // row 0, col 0 → lat [-90,-45), lon [-180,-90)
  states[(height - 1) * width + (width - 1)] = MASK_COASTAL; // top-right
  const mask = decodeMaskBuffer(buildMaskFileBuffer(states, width, height));

  assert.equal(maskStateAt(mask, -89.9, -179.9), MASK_LAND);
  assert.equal(maskStateAt(mask, 89.9, 179.9), MASK_COASTAL);
  // lat exactly +90 clamps into the top row instead of overflowing.
  assert.equal(maskStateAt(mask, 90, 179.9), MASK_COASTAL);
  // Longitude wraps: 180.1 ≡ -179.9 (col 0).
  assert.equal(maskStateAt(mask, -89.9, 180.1), MASK_LAND);
  assert.equal(maskStateAt(mask, -89.9, -539.9), MASK_LAND); // -539.9 ≡ -179.9
});
