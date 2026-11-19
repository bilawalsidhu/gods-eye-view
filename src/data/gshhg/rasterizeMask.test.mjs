import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MASK_COASTAL, MASK_LAND, MASK_WATER } from '../landSeaMaskCodec.js';
import { rasterizeMask } from './rasterizeMask.js';

// Small grid keeps fixtures readable; rasterizeMask must accept any dims.
const WIDTH = 64;
const HEIGHT = 32; // 5.625 deg cells

/** Builds a polygon record shaped like parseGshhg output ([lon, lat] pairs). */
function polygon(level, coords) {
  return { level, points: Float64Array.from(coords.flat()) };
}

/** Reads the rasterized state of the cell containing (lat, lon). */
function stateAt(states, lat, lon) {
  const col = Math.min(WIDTH - 1, Math.floor(((lon + 180) * WIDTH) / 360));
  const row = Math.min(HEIGHT - 1, Math.floor(((lat + 90) * HEIGHT) / 180));
  return states[row * WIDTH + col];
}

function rasterize(polygons) {
  return rasterizeMask(polygons, { width: WIDTH, height: HEIGHT });
}

test('level-1 square: interior land, boundary coastal, exterior water', () => {
  const states = rasterize([
    polygon(1, [
      [-45, -45],
      [45, -45],
      [45, 45],
      [-45, 45],
    ]),
  ]);
  assert.equal(states.length, WIDTH * HEIGHT);
  assert.equal(stateAt(states, 0, 0), MASK_LAND);
  assert.equal(stateAt(states, 20, -20), MASK_LAND);
  assert.equal(stateAt(states, 0, -45), MASK_COASTAL); // west edge
  assert.equal(stateAt(states, 0, 45), MASK_COASTAL); // east edge
  assert.equal(stateAt(states, 45, 0), MASK_COASTAL); // north edge
  assert.equal(stateAt(states, 0, -90), MASK_WATER);
  assert.equal(stateAt(states, 60, 0), MASK_WATER);
  assert.equal(stateAt(states, -60, 120), MASK_WATER);
  assert.equal(stateAt(states, -48, 0), MASK_WATER);
  assert.equal(stateAt(states, 54, 0), MASK_WATER);
});

test('level-2 lake inside level-1 land rasterizes as water', () => {
  const states = rasterize([
    polygon(1, [
      [-45, -45],
      [45, -45],
      [45, 45],
      [-45, 45],
    ]),
    polygon(2, [
      [-20, -20],
      [20, -20],
      [20, 20],
      [-20, 20],
    ]),
  ]);
  assert.equal(stateAt(states, 0, 0), MASK_WATER); // lake interior
  assert.equal(stateAt(states, 30, 30), MASK_LAND); // land ring around lake
  assert.equal(stateAt(states, 0, 20), MASK_COASTAL); // lake shore
  assert.equal(stateAt(states, 0, -90), MASK_WATER); // open ocean
});

test('level-3 island inside a lake rasterizes as land (levels sorted ascending)', () => {
  // Deliberately unsorted input: the rasterizer must order levels itself.
  const states = rasterize([
    polygon(3, [
      [-8, -8],
      [8, -8],
      [8, 8],
      [-8, 8],
    ]),
    polygon(1, [
      [-45, -45],
      [45, -45],
      [45, 45],
      [-45, 45],
    ]),
    polygon(2, [
      [-20, -20],
      [20, -20],
      [20, 20],
      [-20, 20],
    ]),
  ]);
  assert.equal(stateAt(states, 0, 0), MASK_LAND); // island interior
  assert.equal(stateAt(states, 0, 14), MASK_WATER); // lake ring
  assert.equal(stateAt(states, 30, 30), MASK_LAND); // outer land
  assert.equal(stateAt(states, 0, -90), MASK_WATER);
});

test('ring crossing the dateline fills both sides', () => {
  const states = rasterize([
    polygon(1, [
      [170, -10],
      [-170, -10],
      [-170, 10],
      [170, 10],
    ]),
  ]);
  assert.equal(stateAt(states, 0, 175), MASK_LAND); // west of dateline
  assert.equal(stateAt(states, 0, -175), MASK_LAND); // east of dateline
  assert.equal(stateAt(states, 0, 170), MASK_COASTAL); // west edge
  assert.equal(stateAt(states, 0, 0), MASK_WATER);
  assert.equal(stateAt(states, 0, 160), MASK_WATER);
  assert.equal(stateAt(states, 14, -175), MASK_WATER);
  assert.equal(stateAt(states, -14, -175), MASK_WATER);
});

test('level-4 ponds carve water into islands within lakes', () => {
  const states = rasterizeMask(
    [
      polygon(1, [
        [-40, -40],
        [40, -40],
        [40, 40],
        [-40, 40],
      ]),
      polygon(2, [
        [-30, -30],
        [30, -30],
        [30, 30],
        [-30, 30],
      ]),
      polygon(3, [
        [-20, -20],
        [20, -20],
        [20, 20],
        [-20, 20],
      ]),
      polygon(4, [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ]),
    ],
    { width: 360, height: 180 },
  );
  assert.equal(states[90 * 360 + 180], MASK_WATER);
  assert.equal(states[90 * 360 + 195], MASK_LAND);
  assert.equal(states[90 * 360 + 205], MASK_WATER);
});

test('diagonal shoreline marks clipped cells in both traversal directions', () => {
  const points = [
    [-179.375, -89.125],
    [-178.875, -88.75],
  ];
  for (const coords of [points, [...points].reverse()]) {
    const states = rasterizeMask([polygon(1, coords)], {
      width: 360,
      height: 180,
    });
    assert.equal(states[360], MASK_COASTAL, 'edge crosses column 0, row 1');
    assert.equal(states[0], MASK_COASTAL);
    assert.equal(states[361], MASK_COASTAL);
    assert.equal(states[1], MASK_WATER, 'untouched side stays water');
  }
});

test('grid traversal covers corners and retains half-open grid-line membership', () => {
  const states = rasterizeMask(
    [
      polygon(1, [
        [-179.5, -89.5],
        [-178.5, -88.5],
      ]),
      polygon(1, [
        [-170, -80.5],
        [-170, -78.5],
      ]),
    ],
    { width: 360, height: 180 },
  );
  for (const index of [0, 1, 360, 361]) {
    assert.equal(states[index], MASK_COASTAL, `corner contact ${index}`);
  }
  for (const row of [9, 10, 11]) {
    assert.equal(states[row * 360 + 9], MASK_WATER);
    assert.equal(states[row * 360 + 10], MASK_COASTAL);
  }
});

test('diagonal traversal wraps columns at the dateline and clamps pole contacts', () => {
  const states = rasterizeMask(
    [
      polygon(1, [
        [179.625, -89.125],
        [-179.875, -88.75],
      ]),
      polygon(1, [
        [10.25, 90],
        [10.75, 90],
      ]),
    ],
    { width: 360, height: 180 },
  );
  assert.equal(states[360 + 359], MASK_COASTAL);
  assert.equal(states[360], MASK_COASTAL);
  assert.equal(states[179 * 360 + 190], MASK_COASTAL);
  assert.equal(states[2 * 360], MASK_WATER, 'no spill into a neighboring row');
});

test('negative traversal stops at the half-open integer endpoint', () => {
  const states = rasterizeMask(
    [
      polygon(1, [
        [10, 10],
        [10, 9],
      ]),
    ],
    { width: 360, height: 180 },
  );
  assert.equal(states[100 * 360 + 190], MASK_COASTAL);
  assert.equal(states[99 * 360 + 190], MASK_COASTAL);
  assert.equal(
    states[98 * 360 + 190],
    MASK_WATER,
    'do not step beyond the endpoint',
  );
});

test('a repeated vertex marks one cell without traversing beyond it', () => {
  const states = rasterizeMask(
    [
      polygon(1, [
        [0.5, 0.5],
        [0.5, 0.5],
      ]),
    ],
    { width: 360, height: 180 },
  );
  assert.equal(states[90 * 360 + 180], MASK_COASTAL);
  assert.equal(states.filter((value) => value === MASK_COASTAL).length, 1);
});

test('globe-circling level-5 ring fills everything south, including row 0', () => {
  const coords = [];
  for (let k = 0; k < 36; k += 1) coords.push([-180 + k * 10, -70]);
  const states = rasterize([polygon(5, coords)]);
  for (let col = 0; col < WIDTH; col += 1) {
    assert.equal(states[col], MASK_LAND, `row 0 col ${col} must be land`);
  }
  assert.equal(stateAt(states, -80, 33), MASK_LAND); // interior of the cap
  // Artificial seam edges must not leave a coastal (or water) stripe.
  assert.equal(stateAt(states, -80, 170), MASK_LAND);
  assert.equal(stateAt(states, -80, -180), MASK_LAND);
  assert.equal(stateAt(states, -70, 0), MASK_COASTAL); // the ice front itself
  assert.equal(stateAt(states, -60, -140), MASK_WATER); // north of the front
  assert.equal(stateAt(states, 0, 0), MASK_WATER);
});

test('pole seam never cuts through a bay when vertex 0 sits on a multiply-crossed meridian', () => {
  // Vertex 0's meridian (lon 5) crosses this ring's coast three times: the
  // ring dips into a bay (lat -55 to -70) east of lon -3. A seam dropped from
  // vertex 0 would flip the ocean between it and the bay's west wall to land.
  const states = rasterizeMask(
    [
      polygon(5, [
        [5, -50],
        [10, -50],
        [10, -55],
        [-3, -55],
        [-3, -70],
        [90, -70],
        [180, -70],
        [-90, -70],
        [-5, -70],
        [-5, -50],
      ]),
    ],
    { width: 360, height: 180 },
  );
  const at = (lat, lon) =>
    states[Math.floor(lat + 90) * 360 + Math.floor(lon + 180)];
  assert.equal(at(-59.5, 0.5), MASK_WATER); // bay, just east of the old seam
  assert.equal(at(-59.5, 5.5), MASK_WATER);
  assert.equal(at(-80.5, 0.5), MASK_LAND); // cap south of the ice front
});

test('sub-cell polygon marks its cell coastal only, never land', () => {
  const states = rasterize([
    polygon(1, [
      [1, 1],
      [2, 1],
      [2, 2],
      [1, 2],
    ]),
  ]);
  assert.equal(stateAt(states, 1.5, 1.5), MASK_COASTAL);
  assert.equal(stateAt(states, 1.5, 7), MASK_WATER); // east neighbor cell
  assert.equal(stateAt(states, 7, 1.5), MASK_WATER); // north neighbor cell
  assert.equal(states.indexOf(MASK_LAND), -1); // no interior fill anywhere
});
