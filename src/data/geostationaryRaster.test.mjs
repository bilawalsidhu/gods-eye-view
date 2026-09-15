import test from 'node:test';
import assert from 'node:assert/strict';
import { reprojectToEquirectangular } from '../../server/providers/geostationary/raster.js';
import { satelliteNav } from '../../server/providers/geostationary/projection.js';

test('reprojects RGBA imagery and splits antimeridian parts', () => {
  const source = new Uint8Array(64 * 64 * 4);
  for (let row = 0; row < 64; row += 1)
    for (let col = 0; col < 64; col += 1) {
      const i = (row * 64 + col) * 4;
      source[i] = Math.round((col / 63) * 255);
      source[i + 1] = Math.round((row / 63) * 255);
      source[i + 3] = 255;
    }
  const copy = source.slice();
  const result = reprojectToEquirectangular({
    rgba: source,
    srcWidth: 64,
    srcHeight: 64,
    nav: satelliteNav(-75.2),
    outputHeight: 64,
  });
  assert.equal(result.parts.length, 1);
  const part = result.parts[0];
  assert.deepEqual(source, copy);
  assert.ok(Math.abs(part.rectangle.west - -156.4995) < 0.1);
  assert.ok(Math.abs(part.rectangle.south - -81.3282) < 0.1);
  assert.ok(Math.abs(part.rectangle.east - 6.0995) < 0.1);
  assert.ok(Math.abs(part.rectangle.north - 81.3282) < 0.1);
  const center = (32 * part.width + Math.floor(part.width / 2)) * 4;
  assert.equal(part.rgba[center + 3], 255);
  assert.ok(Math.abs(part.rgba[center] - 128) <= 3);
  assert.ok(Math.abs(part.rgba[center + 1] - 128) <= 3);
  for (const i of [
    0,
    part.width - 1,
    (part.height - 1) * part.width,
    part.height * part.width - 1,
  ])
    assert.equal(part.rgba[i * 4 + 3], 0);
  const west = reprojectToEquirectangular({
    rgba: source,
    srcWidth: 64,
    srcHeight: 64,
    nav: satelliteNav(-137),
    outputHeight: 64,
  });
  assert.equal(west.parts.length, 2);
  for (const item of west.parts)
    assert.ok(
      item.rectangle.west < item.rectangle.east &&
        item.rectangle.west >= -180 &&
        item.rectangle.east <= 180,
    );
  assert.ok(
    west.parts.some(
      (item) => item.rectangle.west > 0 && item.rectangle.east === 180,
    ),
  );
  assert.ok(
    west.parts.some(
      (item) => item.rectangle.west === -180 && item.rectangle.east < 0,
    ),
  );
});
