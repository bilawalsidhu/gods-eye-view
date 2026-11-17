import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import {
  STAR_LIMIT_MAGNITUDE,
  STAR_MAX_SIGMA_PX,
  STAR_MIN_ALPHA,
  STAR_MIN_SIGMA_PX,
  STAR_VERTEX_FLOATS,
  buildStarVertices,
  bvToRgb,
  bvToTemperature,
  raDecToUnitVector,
  starAppearance,
  starBrightness,
} from './stars.js';

const close = (actual, expected, epsilon = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${actual} is not within ${epsilon} of ${expected}`,
  );

const skyFile = (name) =>
  new URL(`../data/local_data/sky/${name}`, import.meta.url);

test('right ascension and declination map onto the ICRF axes', () => {
  const equinox = raDecToUnitVector(0, 0);
  close(equinox[0], 1);
  close(equinox[1], 0);
  close(equinox[2], 0);
  const sixHours = raDecToUnitVector(90, 0);
  close(sixHours[0], 0);
  close(sixHours[1], 1);
  const pole = raDecToUnitVector(123, 90);
  close(pole[2], 1);
  const south = raDecToUnitVector(200, -30);
  close(Math.hypot(...south), 1);
  close(south[2], -0.5);
});

test('brightness grows with each magnitude and stops at the catalogue limit', () => {
  close(starBrightness(STAR_LIMIT_MAGNITUDE), 1);
  close(starBrightness(STAR_LIMIT_MAGNITUDE + 1.5), 1);
  close(starBrightness(STAR_LIMIT_MAGNITUDE - 5), 10);
  close(starBrightness(Number.NaN), 1);
});

test('brighter stars are never smaller or fainter, and both ends clamp', () => {
  let previous = starAppearance(8);
  assert.deepEqual(previous, {
    sigmaPx: STAR_MIN_SIGMA_PX,
    alpha: STAR_MIN_ALPHA,
  });
  for (let vmag = 7.5; vmag >= -1.5; vmag -= 0.25) {
    const next = starAppearance(vmag);
    assert.ok(next.sigmaPx >= previous.sigmaPx, `σ shrank at ${vmag}`);
    assert.ok(next.alpha >= previous.alpha, `alpha dropped at ${vmag}`);
    previous = next;
  }
  const sirius = starAppearance(-1.46);
  assert.equal(sirius.alpha, 1);
  assert.ok(sirius.sigmaPx <= STAR_MAX_SIGMA_PX);
  assert.ok(sirius.sigmaPx > starAppearance(2).sigmaPx);
  // Sprites stay point-like: ±3σ of the brightest star is a few pixels.
  assert.ok(6 * STAR_MAX_SIGMA_PX < 10);
});

test('B−V colours run from blue-white to orange with the peak channel at 1', () => {
  close(bvToTemperature(0.65), 5_800, 120);
  close(bvToTemperature(0), 10_100, 200);
  const hot = bvToRgb(-0.3);
  const sunLike = bvToRgb(0.65);
  const cool = bvToRgb(1.6);
  for (const rgb of [hot, sunLike, cool]) {
    close(Math.max(...rgb), 1);
    assert.ok(Math.min(...rgb) > 0.5, 'colours stay desaturated');
  }
  assert.ok(hot[2] > hot[0], 'hot stars are blue');
  assert.ok(cool[0] > cool[2], 'cool stars are orange');
  assert.deepEqual(bvToRgb(null), bvToRgb(0.6));
  assert.deepEqual(bvToRgb(9), bvToRgb(2));
});

test('vertex data is interleaved per star', () => {
  const { count, vertices } = buildStarVertices({
    stars: [0, 0, 1, 0.5, 90, 45, 3, null],
  });
  assert.equal(count, 2);
  assert.equal(vertices.length, 2 * STAR_VERTEX_FLOATS);
  assert.deepEqual(Array.from(vertices.subarray(0, 3)), [1, 0, 0]);
  close(vertices[STAR_VERTEX_FLOATS + 1], Math.SQRT1_2, 1e-6);
  close(vertices[STAR_VERTEX_FLOATS + 2], Math.SQRT1_2, 1e-6);
  close(vertices[3], starAppearance(1).sigmaPx, 1e-6);
  close(vertices[7], starAppearance(1).alpha, 1e-6);
});

test('the committed catalogue holds the Yale Bright Star Catalogue', () => {
  const pack = JSON.parse(readFileSync(skyFile('bright_stars.json'), 'utf8'));
  assert.deepEqual(pack.meta.columns, ['raDeg', 'decDeg', 'vmag', 'bv']);
  assert.equal(pack.stars.length, pack.meta.count * 4);
  assert.equal(pack.meta.count, 9096);
  let brightest = 0;
  for (let i = 0; i < pack.stars.length; i += 4) {
    const [ra, dec, vmag] = pack.stars.slice(i, i + 4);
    assert.ok(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90);
    assert.ok(Number.isFinite(vmag));
    if (vmag < pack.stars[brightest + 2]) brightest = i;
  }
  // Sirius, α CMa: 06h45m08.9s −16°42′58″, V = −1.46.
  assert.deepEqual(
    pack.stars.slice(brightest, brightest + 4),
    [101.287, -16.716, -1.46, 0],
  );
  assert.equal(buildStarVertices(pack).count, pack.meta.count);
});

test('sky assets stay inside the 5 MB budget', () => {
  const files = [
    'bright_stars.json',
    ...['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(
      (face) => `milkyway_${face}.webp`,
    ),
  ];
  const total = files.reduce(
    (sum, name) => sum + statSync(skyFile(name)).size,
    0,
  );
  assert.ok(total < 5 * 1024 * 1024, `${total} bytes`);
});
