import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseGshhg } from './parseGshhg.js';

const HEADER_INT32S = 11;

/**
 * Encodes one GSHHG v2.3.7 native .b polygon record (11 big-endian int32
 * header + n big-endian (lon, lat) micro-degree int32 pairs) for synthetic
 * test streams.
 * @param {object} spec
 * @returns {Uint8Array}
 */
function encodePolygon({
  id = 0,
  level = 1,
  greenwich = 0,
  river = 0,
  west = -10_000_000,
  east = 10_000_000,
  south = -5_000_000,
  north = 5_000_000,
  area = 42,
  areaFull = 43,
  container = -1,
  ancestor = -1,
  points = [],
  headerN = null,
}) {
  const n = headerN === null ? points.length / 2 : headerN;
  const flag = (level & 255) | ((greenwich & 1) << 16) | ((river & 1) << 25);
  const bytes = new Uint8Array((HEADER_INT32S + points.length) * 4);
  const view = new DataView(bytes.buffer);
  const header = [id, n, flag, west, east, south, north, area, areaFull, container, ancestor];
  header.forEach((value, i) => view.setInt32(i * 4, value, false));
  points.forEach((value, i) => view.setInt32((HEADER_INT32S + i) * 4, value, false));
  return bytes;
}

/** Concatenates encoded records into one ArrayBuffer stream. */
function stream(...records) {
  const total = records.reduce((sum, r) => sum + r.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const r of records) {
    out.set(r, offset);
    offset += r.byteLength;
  }
  return out.buffer;
}

test('decodes a single polygon header with micro-degree bounds -> degrees', () => {
  const buf = stream(encodePolygon({
    id: 7,
    level: 1,
    west: -122_500_000,
    east: -121_000_000,
    south: 36_250_000,
    north: 37_750_000,
    area: 1234,
    areaFull: 5678,
    container: 3,
    ancestor: 9,
    points: [-122_000_000, 37_000_000, -121_500_000, 36_500_000, -122_250_000, 36_750_000],
  }));
  const polygons = parseGshhg(buf);
  assert.equal(polygons.length, 1);
  const p = polygons[0];
  assert.equal(p.id, 7);
  assert.equal(p.n, 3);
  assert.equal(p.level, 1);
  assert.equal(p.greenwich, false);
  assert.equal(p.river, false);
  assert.equal(p.west, -122.5);
  assert.equal(p.east, -121);
  assert.equal(p.south, 36.25);
  assert.equal(p.north, 37.75);
  assert.equal(p.area, 1234);
  assert.equal(p.areaFull, 5678);
  assert.equal(p.container, 3);
  assert.equal(p.ancestor, 9);
});

test('unpacks flag bits: level, greenwich, river', () => {
  const buf = stream(encodePolygon({
    level: 2,
    greenwich: 1,
    river: 1,
    points: [0, 0, 1_000_000, 0, 0, 1_000_000],
  }));
  const [p] = parseGshhg(buf);
  assert.equal(p.level, 2);
  assert.equal(p.greenwich, true);
  assert.equal(p.river, true);
});

test('converts micro-degree points to a [lon, lat, ...] Float64Array in degrees', () => {
  const buf = stream(encodePolygon({
    points: [-180_000_000, -90_000_000, 1_234_567, 89_999_999, 179_999_999, 0],
  }));
  const [p] = parseGshhg(buf);
  assert.ok(p.points instanceof Float64Array);
  assert.equal(p.points.length, 6);
  assert.equal(p.points[0], -180);
  assert.equal(p.points[1], -90);
  assert.equal(p.points[2], 1.234567);
  assert.equal(p.points[3], 89.999999);
  assert.equal(p.points[4], 179.999999);
  assert.equal(p.points[5], 0);
});

test('parses a multi-polygon stream in order', () => {
  const buf = stream(
    encodePolygon({ id: 0, level: 1, points: [0, 0, 1_000_000, 0, 0, 1_000_000] }),
    encodePolygon({ id: 1, level: 2, points: [5_000_000, 5_000_000, 6_000_000, 5_000_000] }),
    encodePolygon({ id: 2, level: 4, points: [7_000_000, 7_000_000] }),
  );
  const polygons = parseGshhg(buf);
  assert.deepEqual(polygons.map((p) => p.id), [0, 1, 2]);
  assert.deepEqual(polygons.map((p) => p.level), [1, 2, 4]);
  assert.deepEqual(polygons.map((p) => p.n), [3, 2, 1]);
  assert.equal(polygons[1].points[0], 5);
});

test('skips level-6 (Antarctica grounding line) polygons but keeps parsing past them', () => {
  const buf = stream(
    encodePolygon({ id: 10, level: 1, points: [0, 0, 1_000_000, 0] }),
    encodePolygon({ id: 11, level: 6, points: [0, -89_000_000, 90_000_000, -89_000_000, 180_000_000, -89_000_000] }),
    encodePolygon({ id: 12, level: 5, points: [0, -70_000_000, 90_000_000, -70_000_000] }),
  );
  const polygons = parseGshhg(buf);
  assert.deepEqual(polygons.map((p) => p.id), [10, 12]);
  assert.deepEqual(polygons.map((p) => p.level), [1, 5]);
  // The polygon after the skipped L6 record decodes from the right offset.
  assert.equal(polygons[1].points[1], -70);
});

test('accepts a Uint8Array view (node Buffer idiom) with a nonzero byteOffset', () => {
  const record = encodePolygon({ id: 3, points: [1_000_000, 2_000_000] });
  const padded = new Uint8Array(record.byteLength + 8);
  padded.set(record, 8);
  const view = new Uint8Array(padded.buffer, 8, record.byteLength);
  const [p] = parseGshhg(view);
  assert.equal(p.id, 3);
  assert.equal(p.points[1], 2);
});

test('throws on a truncated header', () => {
  const record = encodePolygon({ points: [0, 0, 1_000_000, 0] });
  const buf = stream(record).slice(0, HEADER_INT32S * 4 - 3);
  assert.throws(() => parseGshhg(buf), /truncat/i);
});

test('throws when the buffer ends before the declared point count', () => {
  const record = encodePolygon({ points: [0, 0, 1_000_000, 0, 2_000_000, 0] });
  const buf = stream(record).slice(0, record.byteLength - 4);
  assert.throws(() => parseGshhg(buf), /truncat/i);
});

test('throws on an insane point count (n <= 0 or n >= 10,000,000)', () => {
  const zero = stream(encodePolygon({ points: [], headerN: 0 }));
  assert.throws(() => parseGshhg(zero), /point count/i);

  const negative = stream(encodePolygon({ points: [0, 0], headerN: -5 }));
  assert.throws(() => parseGshhg(negative), /point count/i);

  const huge = stream(encodePolygon({ points: [0, 0], headerN: 10_000_000 }));
  assert.throws(() => parseGshhg(huge), /point count/i);
});
