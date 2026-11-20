// src/data/aircraftIcons.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { aircraftIcon, ROTOR_FRAMES } from './aircraftIcons.js';

const KINDS = [
  'airliner',
  'widebody',
  'quadjet',
  'turboprop',
  'light',
  'glider',
  'fastjet',
  'bizjet',
  'uav',
  'helicopter',
  'vehicle',
  'station',
  'tr3b',
  'tr3bHot',
];
const PX = 480;

/** Farthest painted pixel from the centre, in the 96-unit glyph space. */
async function halfExtent(uri) {
  const svg = Buffer.from(uri.split(',')[1], 'base64');
  const { data, info } = await sharp(svg)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let half = 0;
  const c = info.width / 2;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] <= 8) continue;
      half = Math.max(half, c - x, x + 1 - c, c - y, y + 1 - c);
    }
  }
  return (half * 96) / info.width;
}

test('every sprite fills the same extent, whatever its class', async () => {
  const extents = {};
  for (const kind of KINDS) {
    extents[kind] = await halfExtent(aircraftIcon(kind, PX));
  }
  for (let frame = 0; frame < ROTOR_FRAMES; frame++) {
    extents[`helicopter#${frame}`] = await halfExtent(
      aircraftIcon('helicopter', PX, frame),
    );
  }
  for (const [kind, half] of Object.entries(extents)) {
    assert.ok(Math.abs(half - 44) <= 0.6, `${kind}: ${half.toFixed(2)}`);
  }
});
