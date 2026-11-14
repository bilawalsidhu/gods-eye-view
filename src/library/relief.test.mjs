import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RELIEF_CLASSES,
  metresPerPixel,
  terrariumHeight,
  terrariumToRelief,
} from './relief.js';
import { libraryEntry } from './catalog.js';
import { validateLibraryManifest } from './manifest.js';

/** Terrarium RGB for a height in metres. */
function encode(height) {
  const value = height + 32768;
  const r = Math.floor(value / 256);
  const g = Math.floor(value - r * 256);
  const b = Math.round((value - Math.floor(value)) * 256);
  return [r, g, b, 255];
}

function tile(width, height, heightAt) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      pixels.set(encode(heightAt(x, y)), (y * width + x) * 4);
  return pixels;
}

test('Terrarium pixels decode to metres', () => {
  assert.equal(terrariumHeight(...encode(0)), 0);
  assert.equal(terrariumHeight(...encode(4478)), 4478);
  assert.equal(terrariumHeight(...encode(-432)), -432);
});

test('sea is transparent and flat land takes its elevation class colour', () => {
  const flat = (height) =>
    terrariumToRelief(
      tile(3, 3, () => height),
      3,
      3,
      30,
    );
  assert.equal(flat(0)[3], 0, 'sea (exactly 0 m) stays transparent');
  const near = (out, hex) => {
    const target = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return target.every((value, i) => Math.abs(out[16 + i] - value) <= 12);
  };
  assert.equal(flat(-6)[19], 255);
  assert.ok(
    near(flat(-6), RELIEF_CLASSES[0].color),
    'land below sea level is the lowest class',
  );
  assert.ok(near(flat(600), RELIEF_CLASSES[2].color), '600 m is 500–1,000 m');
  assert.ok(
    near(flat(3500), RELIEF_CLASSES[5].color),
    '3,500 m is the top class',
  );
});

test('a north-west sun lights north-west slopes and shades south-east ones', () => {
  // Height rises to the south-east: the slope faces north-west, into the sun.
  const facingSun = terrariumToRelief(
    tile(5, 5, (x, y) => 400 + 40 * (x + y)),
    5,
    5,
    10,
  );
  const facingAway = terrariumToRelief(
    tile(5, 5, (x, y) => 800 - 40 * (x + y)),
    5,
    5,
    10,
  );
  const centre = 12 * 4;
  assert.ok(facingSun[centre] > facingAway[centre]);
});

test('pixel size shrinks with zoom and latitude', () => {
  assert.ok(Math.abs(metresPerPixel(0, 0, 256) - 156543 * Math.cos(0)) > 0);
  assert.ok(metresPerPixel(10, 300, 512) < metresPerPixel(9, 150, 512));
  const equator = metresPerPixel(4, 7.5, 512);
  assert.ok(Math.abs(equator - 40075016.686 / (512 * 16)) / equator < 0.01);
});

test('only xyz tiles may declare an encoding and a 512 px tile size', () => {
  const mapterhorn = libraryEntry('mapterhorn-terrain');
  assert.equal(mapterhorn.source.encoding, 'terrarium');
  assert.equal(mapterhorn.source.tileSize, 512);
  const raw = structuredClone(mapterhorn);
  raw.source.encoding = 'mapbox';
  raw.source.tileSize = 300;
  const { errors } = validateLibraryManifest(raw);
  assert.ok(errors.some((e) => e.startsWith('source.encoding is for tiles')));
  assert.ok(errors.includes('source.tileSize is 256 or 512, for tiles'));
});
