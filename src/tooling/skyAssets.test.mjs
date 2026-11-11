import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildStarPack,
  parseBscRecord,
} from '../../scripts/build-bright-stars.mjs';
import {
  CUBE_FACES,
  cubeFaceDirection,
  directionToPlateCarree,
  icrfToGalactic,
  smoothstep,
  softBlack,
} from '../../scripts/build-milky-way.mjs';
import { raDecToUnitVector } from '../sky/stars.js';

// Verbatim CDS V/50 records: HR 1, Sirius (HR 2491) and a nova with no J2000
// position. Columns matter, so the padding is part of the fixture.
const HR_1 =
  '   1          BD+44 4550      3 36042          46           000001.1+444022000509.9+451345114.44-16.88 6.70  +0.07 +0.08         A1Vn               -0.012-0.018      -018      195  4.2  21.6AC   3';
const SIRIUS =
  '2491  9Alp CMaBD-16 1591  48915151881 257I   5423           064044.6-163444064508.9-164258227.22-08.88-1.46   0.00 -0.05 -0.03   A1Vm               -0.553-1.205 +.375-008SBO    13 10.3  11.2AB   4*';
const NOVA =
  '  92 NOVA 1572                                     B Cas                                                                                                                                            *';

const close = (actual, expected, epsilon = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${actual} is not within ${epsilon} of ${expected}`,
  );

test('BSC5 records parse J2000 position, V magnitude and B−V', () => {
  const sirius = parseBscRecord(SIRIUS);
  assert.equal(sirius.hr, 2491);
  close(sirius.raDeg, (6 + 45 / 60 + 8.9 / 3600) * 15);
  close(sirius.decDeg, -(16 + 42 / 60 + 58 / 3600));
  assert.equal(sirius.vmag, -1.46);
  assert.equal(sirius.bv, 0);
  const first = parseBscRecord(HR_1);
  close(first.raDeg, (5 / 60 + 9.9 / 3600) * 15);
  close(first.decDeg, 45 + 13 / 60 + 45 / 3600);
  assert.equal(first.vmag, 6.7);
  assert.equal(first.bv, 0.07);
  assert.equal(parseBscRecord(NOVA), null);
});

test('the star pack is a flat, rounded column array that counts its drops', () => {
  const pack = buildStarPack([HR_1, NOVA, SIRIUS, ''].join('\n'), {
    fetched: '2026-10-19',
  });
  assert.deepEqual(
    pack.stars,
    [1.291, 45.229, 6.7, 0.07, 101.287, -16.716, -1.46, 0],
  );
  assert.equal(pack.meta.count, 2);
  assert.equal(pack.meta.dropped, 1);
  assert.equal(pack.meta.fetched, '2026-10-19');
});

test('cube faces use the WebGL major-axis layout', () => {
  // Each face centre looks down its own axis …
  const axes = {
    positiveX: [1, 0, 0],
    negativeX: [-1, 0, 0],
    positiveY: [0, 1, 0],
    negativeY: [0, -1, 0],
    positiveZ: [0, 0, 1],
    negativeZ: [0, 0, -1],
  };
  for (const face of CUBE_FACES)
    assert.deepEqual(
      cubeFaceDirection(face, 0.5, 0.5).map((v) => v + 0),
      axes[face],
    );
  // … and the first texel row and column follow OpenGL ES 3.0 §3.8.10:
  // on +X, s grows towards −Z and t towards −Y.
  assert.deepEqual(cubeFaceDirection('positiveX', 0, 0), [1, 1, 1]);
  assert.deepEqual(cubeFaceDirection('positiveZ', 1, 1), [1, -1, 1]);
  assert.deepEqual(cubeFaceDirection('negativeY', 0, 1), [-1, -1, -1]);
  assert.throws(() => cubeFaceDirection('up', 0, 0), RangeError);
});

test('plate carrée is centred on longitude 0, growing to the left, north up', () => {
  assert.deepEqual(directionToPlateCarree(1, 0, 0), [0.5, 0.5]);
  const sixHours = directionToPlateCarree(0, 1, 0);
  close(sixHours[0], 0.25);
  const eighteenHours = directionToPlateCarree(0, -1, 0);
  close(eighteenHours[0], 0.75);
  close(directionToPlateCarree(0, 0, 1)[1], 0);
  close(directionToPlateCarree(0, 0, -1)[1], 1);
  const twelveHours = directionToPlateCarree(-1, 0, 0);
  assert.ok(twelveHours[0] === 0 || twelveHours[0] === 1);
});

test('the galactic rotation puts the Galactic Centre and pole where the IAU does', () => {
  // Galactic origin l = b = 0 at RA 266.405°, Dec −28.936° (J2000).
  const centre = icrfToGalactic(raDecToUnitVector(266.40499, -28.93617));
  close(centre[0], 1, 1e-6);
  // North galactic pole at RA 192.85948°, Dec +27.12825°.
  const pole = icrfToGalactic(raDecToUnitVector(192.85948, 27.12825));
  close(pole[2], 1, 1e-6);
  // ESO's panorama: the Large Magellanic Cloud (l ≈ 280.5°, b ≈ −32.9°) sits
  // right of and below the centre.
  const [u, v] = directionToPlateCarree(
    ...icrfToGalactic(raDecToUnitVector(80.894, -69.756)),
  );
  close(u, 0.5 + (360 - 280.47) / 360, 2e-3);
  close(v, 0.5 + 32.89 / 180, 2e-3);
});

test('the black level eases in instead of cutting the faint sky into contours', () => {
  assert.equal(softBlack(-0.2), 0);
  assert.equal(softBlack(0), 0);
  // Continuous, rising, with no step at the black level.
  let previous = 0;
  for (let x = 0.001; x <= 1; x += 0.001) {
    const y = softBlack(x);
    assert.ok(y > previous && y - previous < 0.0011, `step at ${x.toFixed(3)}`);
    previous = y;
  }
  // Starts flat, then joins the straight line just below it.
  assert.ok(softBlack(0.003) < 0.0003);
  close(softBlack(1), 1 - 0.03, 1e-3);
});

test('the faint-glow blend weight eases between its edges', () => {
  assert.equal(smoothstep(0.1, 0.2, 0), 0);
  assert.equal(smoothstep(0.1, 0.2, 0.1), 0);
  close(smoothstep(0.1, 0.2, 0.15), 0.5, 1e-9);
  assert.equal(smoothstep(0.1, 0.2, 0.2), 1);
  assert.equal(smoothstep(0.1, 0.2, 9), 1);
});
