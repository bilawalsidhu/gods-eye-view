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
  assert.equal(
    packed[0],
    states[0] | (states[1] << 2) | (states[2] << 4) | (states[3] << 6),
  );

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

test('maskStateAt reads non-finite coordinates as coastal, never as water', () => {
  const mask = decodeMaskBuffer(buildMaskFileBuffer(new Uint8Array(16), 4, 4));
  for (const [lat, lon] of [
    [NaN, 0],
    [0, NaN],
    [Infinity, 0],
    [0, -Infinity],
  ]) {
    assert.equal(maskStateAt(mask, lat, lon), MASK_COASTAL, `(${lat}, ${lon})`);
  }
});

test('maskStateAt accepts ±90 as boundary rows but fails closed on finite off-globe latitudes', () => {
  // Every cell is LAND, so any read that reaches the grid returns MASK_LAND;
  // a MASK_COASTAL result can only come from the guard, not from the data.
  const width = 4;
  const height = 4;
  const states = new Uint8Array(width * height).fill(MASK_LAND);
  const mask = decodeMaskBuffer(buildMaskFileBuffer(states, width, height));

  // Exactly ±90 are valid WGS84 boundary cases: +90 clamps into the top row,
  // -90 is the first row's own lower edge.
  assert.equal(maskStateAt(mask, 90, 0), MASK_LAND);
  assert.equal(maskStateAt(mask, -90, 0), MASK_LAND);

  // Finite but not a geographic position: never a confident polar answer.
  for (const lat of [
    90.00001,
    -90.00001,
    91,
    -91,
    100,
    -100,
    1000,
    -1e6,
    Number.MAX_VALUE,
  ]) {
    assert.equal(maskStateAt(mask, lat, 0), MASK_COASTAL, `lat ${lat}`);
  }
  // Longitude stays intentionally wrapped — only latitude is range-gated.
  assert.equal(maskStateAt(mask, 0, 1000), MASK_LAND);
});

test('decodeMaskBuffer rejects zero height, a short header and a padded file', () => {
  const good = buildMaskFileBuffer(new Uint8Array(16), 8, 2);

  const zeroHeight = good.slice(0);
  new DataView(zeroHeight).setUint32(12, 0, true);
  assert.throws(() => decodeMaskBuffer(zeroHeight), /zero dimension/);

  for (const length of [0, 4, 15]) {
    assert.throws(
      () => decodeMaskBuffer(good.slice(0, length)),
      /truncated: \d+ bytes < 16-byte header/,
      `a ${length}-byte file has no header`,
    );
  }

  const padded = new Uint8Array(good.byteLength + 1);
  padded.set(new Uint8Array(good));
  assert.throws(() => decodeMaskBuffer(padded.buffer), /truncated or padded/);
});

test('decodeMaskBuffer reads a view at its own offset, not the buffer start', () => {
  const states = Uint8Array.from([
    MASK_LAND,
    MASK_COASTAL,
    MASK_WATER,
    MASK_LAND,
    MASK_WATER,
    MASK_LAND,
    MASK_COASTAL,
    MASK_WATER,
  ]);
  const file = new Uint8Array(buildMaskFileBuffer(states, 4, 2));
  // The file sits 7 bytes into a larger buffer whose other bytes are 0xff:
  // reading from the buffer start would fail the magic, and reading past the
  // view would see reserved cells.
  const host = new Uint8Array(file.byteLength + 12).fill(0xff);
  host.set(file, 7);
  const mask = decodeMaskBuffer(
    new Uint8Array(host.buffer, 7, file.byteLength),
  );
  assert.equal(mask.width, 4);
  assert.equal(mask.height, 2);
  assert.equal(mask.data.byteOffset, 7 + 16);
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      assert.equal(
        maskStateAt(mask, -90 + (row + 0.5) * 90, -180 + (col + 0.5) * 90),
        states[row * 4 + col],
      );
    }
  }
  // A DataView is a view too.
  const viaDataView = decodeMaskBuffer(
    new DataView(host.buffer, 7, file.byteLength),
  );
  assert.equal(maskStateAt(viaDataView, -45, -135), MASK_LAND);
});

test('buildMaskFileBuffer rejects bad dimensions and a mismatched state count', () => {
  const states = new Uint8Array(8);
  for (const [width, height] of [
    [0, 8],
    [8, 0],
    [-4, 2],
    [2.5, 2],
    [4, NaN],
  ]) {
    assert.throws(
      () => buildMaskFileBuffer(states, width, height),
      /dimensions must be positive integers/,
      `${width}x${height}`,
    );
  }
  assert.throws(
    () => buildMaskFileBuffer(states, 4, 4),
    /states length 8 != width\*height 16/,
  );
  assert.ok(buildMaskFileBuffer(states, 4, 2));
});

test('packMaskStates rejects states the format has no meaning for', () => {
  for (const stray of [3, 4, 255]) {
    assert.throws(
      () => packMaskStates(Uint8Array.from([MASK_LAND, stray])),
      new RegExp(`mask state ${stray} at cell 1`),
      `state ${stray}`,
    );
  }
  // A stray 4 used to pack as its low two bits, water.
  assert.throws(
    () => buildMaskFileBuffer(Uint8Array.from([4, 0, 0, 0]), 2, 2),
    RangeError,
  );
});

test('maskStateAt fails closed on a reserved cell and on bytes that are not there', () => {
  // Every cell packed as reserved state 3: never a confident answer.
  const reserved = { width: 4, height: 2, data: new Uint8Array(2).fill(0xff) };
  assert.equal(maskStateAt(reserved, 0, 0), MASK_COASTAL);
  assert.equal(maskStateAt(reserved, -89, -179), MASK_COASTAL);

  // Data shorter than the grid: the second row has no byte.
  const short = { width: 4, height: 2, data: Uint8Array.of(0b01010101) };
  assert.equal(maskStateAt(short, -45, 0), MASK_LAND, 'row 0 is there');
  assert.equal(maskStateAt(short, 45, 0), MASK_COASTAL, 'row 1 is not');

  // Transferring the buffer (as to a worker) detaches the view: every read
  // is undefined, which `>>` would turn into water.
  const states = new Uint8Array(16).fill(MASK_LAND);
  const mask = decodeMaskBuffer(buildMaskFileBuffer(states, 4, 4));
  assert.equal(maskStateAt(mask, 0, 0), MASK_LAND);
  structuredClone(mask.data.buffer, { transfer: [mask.data.buffer] });
  assert.equal(mask.data.length, 0, 'detached');
  assert.equal(maskStateAt(mask, 0, 0), MASK_COASTAL);
});
