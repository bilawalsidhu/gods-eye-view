import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  CUBE_FACES,
  FACE_FILE_SUFFIX,
  PLANETS,
  cubeFaceDirection,
  icrfToGalactic,
} from '../../scripts/build-milky-way.mjs';
import { raDecToUnitVector } from '../sky/stars.js';

const SKY = new URL('../data/local_data/sky/', import.meta.url);
// Allowed excess of the painted disc over the surrounding sky, in 8-bit
// levels of the encoded face: the blur and dither move values by a few.
const TOLERANCE = 4;

test('painted-out planets leave no disc brighter than the sky around them', async () => {
  const centres = PLANETS.map((planet) => ({
    planet,
    vector: raDecToUnitVector(planet.l, planet.b),
    disc: [],
    ring: [],
  }));
  for (const face of CUBE_FACES) {
    const { data, info } = await sharp(
      fileURLToPath(new URL(`milkyway_${FACE_FILE_SUFFIX[face]}.webp`, SKY)),
    )
      .raw()
      .toBuffer({ resolveWithObject: true });
    const size = info.width;
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const d = cubeFaceDirection(face, (i + 0.5) / size, (j + 0.5) / size);
        const n = Math.hypot(...d);
        const g = icrfToGalactic(d.map((x) => x / n));
        for (const centre of centres) {
          const cos =
            g[0] * centre.vector[0] +
            g[1] * centre.vector[1] +
            g[2] * centre.vector[2];
          const degrees = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
          const k = (j * size + i) * info.channels;
          const luma = (data[k] + data[k + 1] + data[k + 2]) / 3;
          if (degrees <= centre.planet.radiusDeg - 0.5) centre.disc.push(luma);
          else if (
            degrees >= centre.planet.radiusDeg + 1 &&
            degrees <= centre.planet.radiusDeg + 3.5
          )
            centre.ring.push(luma);
        }
      }
    }
  }
  const median = (values) => values.sort((a, b) => a - b)[values.length >> 1];
  for (const { planet, disc, ring } of centres) {
    const discMean = disc.reduce((s, v) => s + v, 0) / disc.length;
    const ringMedian = median(ring);
    assert.ok(
      discMean <= ringMedian + TOLERANCE,
      `l=${planet.l} b=${planet.b}: disc mean ${discMean.toFixed(1)} vs surrounding sky ${ringMedian.toFixed(1)}`,
    );
  }
});
