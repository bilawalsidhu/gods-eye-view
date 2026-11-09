import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../../geo/index.js';
import { normalizeGroundItem } from '../../ground.js';
import {
  EPSILON_M,
  ITEM_TEXELS,
  LOOK,
  MARGIN_RATIO,
  MAX_PIECE_DEG,
} from './corridors.js';
import {
  BIN_THRESHOLD,
  binArea,
  composeGround,
  GRID_COLS,
  KIND,
  packHeights,
  packSet,
  STYLE_TEXELS,
} from './pack.js';

const items = (kind, list) =>
  list.map((item, index) => normalizeGroundItem(kind, item, index));

test('a set packs its frames, styles and segments', () => {
  const pack = packSet(
    'polygon',
    items('polygon', [
      {
        rings: [
          [
            [55, 25],
            [55.1, 25],
            [55.1, 25.1],
          ],
          [
            [55.05, 25.02],
            [55.08, 25.02],
            [55.08, 25.05],
          ],
        ],
        fill: [1, 0, 0, 0.5],
        outline: { color: [0, 0, 1, 1], widthPx: 3 },
      },
    ]),
  );
  assert.equal(pack.count, 1);
  assert.equal(pack.segments.length / 4, 6, 'three segments per ring');
  const style = pack.styles;
  assert.deepEqual([...style.slice(0, 4)], [1, 0, 0, 0.5]);
  assert.deepEqual([...style.slice(4, 8)], [0, 0, 1, 1]);
  assert.equal(style[8], KIND.area);
  assert.equal(style[9], 3);
  assert.equal(style[14], 0);
  assert.equal(style[15], 6);
  // The plane's origin is on the ellipsoid at the bounds' centre.
  const centre = geo.cartesian3.fromDegrees(55.05, 25.05);
  assert.ok(Math.abs(pack.frames[0] - centre.x) < 1e-6);
  assert.equal(pack.volumes[3], 3 / 2 + 2, 'half the outline + 2 px pad');
});

test('gnomonic segments keep a great-circle edge straight and distances right', () => {
  const [disc] = items('disc', [{ center: [0, 0], radiusM: 100_000 }]);
  const pack = packSet('disc', [disc]);
  const radius = pack.frames[12];
  assert.ok(
    Math.abs(pack.styles[11] - radius * Math.tan(100_000 / radius)) < 0.01,
  );
  assert.equal(pack.styles[8], KIND.disc);
  const corridor = packSet(
    'corridor',
    items('corridor', [
      {
        positions: [
          [-1, 0],
          [1, 0],
        ],
        color: [1, 1, 1, 1],
        widthPx: 4,
      },
    ]),
  );
  // Cut into pieces of at most MAX_PIECE_DEG, each straight in the plane.
  const pieces = corridor.segments.length / 4;
  assert.equal(pieces, Math.ceil(2 / MAX_PIECE_DEG));
  for (let at = 0; at < corridor.segments.length; at += 4) {
    const [ax, ay, bx, by] = corridor.segments.slice(at, at + 4);
    assert.ok(Math.abs(ay) < 1e-3 && Math.abs(by) < 1e-3, 'on the equator');
    if (at) assert.equal(ax, corridor.segments[at - 2], 'joined');
    assert.ok(bx > ax);
  }
  assert.ok(
    Math.abs(corridor.segments[0] + corridor.segments.at(-2)) < 1e-3,
    'centred',
  );
  assert.equal(corridor.styles[8], KIND.corridorTile);
  assert.equal(corridor.items[4], 4, 'the item keeps its width');
});

test('composed sets keep draw order and offset their segments', () => {
  const square = (lon) => ({
    rings: [
      [
        [lon, 0],
        [lon + 1, 0],
        [lon + 1, 1],
        [lon, 1],
      ],
    ],
    fill: [1, 1, 1, 1],
  });
  const first = packSet('polygon', items('polygon', [square(0)]));
  const second = packSet('polygon', items('polygon', [square(0.5)]));
  const state = composeGround([first, second]);
  assert.equal(state.count, 2);
  assert.equal(
    state.styles.data[STYLE_TEXELS * 4 + 14],
    4,
    'second set after four',
  );
  // A camera 2000 km over (0.75, 0.5) looking straight down.
  const eye = geo.cartesian3.fromDegrees(0.75, 0.5, 2e6);
  const target = geo.cartesian3.fromDegrees(0.75, 0.5);
  const up = geo.cartesian3.create(0, 0, 1);
  const zAxis = geo.cartesian3.normalize(
    geo.cartesian3.subtract(eye, target, geo.cartesian3.create()),
    geo.cartesian3.create(),
  );
  const xAxis = geo.cartesian3.normalize(
    geo.cartesian3.cross(up, zAxis, geo.cartesian3.create()),
    geo.cartesian3.create(),
  );
  const yAxis = geo.cartesian3.cross(zAxis, xAxis, geo.cartesian3.create());
  const view = [
    xAxis.x,
    yAxis.x,
    zAxis.x,
    0,
    xAxis.y,
    yAxis.y,
    zAxis.y,
    0,
    xAxis.z,
    yAxis.z,
    zAxis.z,
    0,
    -geo.cartesian3.dot(xAxis, eye),
    -geo.cartesian3.dot(yAxis, eye),
    -geo.cartesian3.dot(zAxis, eye),
    1,
  ];
  const f = 1 / Math.tan(Math.PI / 6);
  const near = 1;
  const far = 1e8;
  const projection = [
    f,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    -(far + near) / (far - near),
    -1,
    0,
    0,
    (-2 * far * near) / (far - near),
    0,
  ];
  assert.equal(state.update(view, projection, 800, 800), true);
  assert.equal(state.update(view, projection, 800, 800), false, 'unchanged');
  // The middle cell holds both, first set first.
  const cell = (GRID_COLS * 40) / 2 + GRID_COLS / 2;
  const [offset, count] = state.grid.data.slice(cell * 4, cell * 4 + 2);
  assert.equal(count, 2);
  assert.deepEqual(
    [
      state.candidates.data[offset * 4],
      state.candidates.data[(offset + 1) * 4],
    ],
    [0, 1],
  );
  // The first frame's centre in view space is in front of the camera.
  assert.ok(state.frames.data[2] < -1.9e6);
});

// Random lines over a region, as the ground bench draws them.
function lines(count, { lon = 55, lat = 25, spread = 0.4, step = 0.004 } = {}) {
  let seed = 7;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  return Array.from({ length: count }, (_, index) => {
    let x = lon + next() * spread;
    let y = lat + next() * spread;
    const heading = next() * 2 * Math.PI;
    const positions = [];
    for (let k = 0; k < 12; k++) {
      positions.push([x, y]);
      const turn = heading + (next() - 0.5) * 1.2;
      x += step * Math.cos(turn);
      y += step * Math.sin(turn);
    }
    return {
      positions,
      color: [1, 1, 1, 1],
      ...(index % 5 ? { widthPx: 2 + (index % 3) } : { widthM: 30 }),
    };
  });
}

// A tile's levels as the shader walks them: [directory start, columns, rows].
function levelsOf(style) {
  const out = [];
  let columns = style[10];
  let rows = style[11];
  let dir = style[18];
  for (let z = 0; z <= style[7]; z++) {
    out.push([dir, columns, rows]);
    dir += columns * rows;
    columns = (columns + 1) >> 1;
    rows = (rows + 1) >> 1;
  }
  return out;
}

test('a corridor set packs as tiles whose bins list every segment near them', () => {
  const checked = items('corridor', lines(80));
  const pack = packSet('corridor', checked, { tilePieces: 300 });
  assert.ok(pack.count > 1, `${pack.count} tiles`);
  assert.ok(pack.count >= 1);
  assert.equal(pack.items.length, checked.length * ITEM_TEXELS * 4);
  for (let tile = 0; tile < pack.count; tile++) {
    const style = pack.styles.slice(
      tile * STYLE_TEXELS * 4,
      (tile + 1) * STYLE_TEXELS * 4,
    );
    assert.equal(style[8], KIND.corridorTile);
    const size = style[9];
    const [x0, y0] = [style[16], style[17]];
    const segmentStart = style[14];
    const runStart = style[15];
    const reference = style[6];
    for (const [z, [dir, columns, rows]] of levelsOf(style).entries()) {
      const bin = size * 2 ** z;
      // Brute force: every segment of the tile within its margin of a bin
      // is in one of the bin's runs.
      for (let row = 0; row < rows; row++)
        for (let column = 0; column < columns; column++) {
          const at = (dir + row * columns + column) * 4;
          const listed = new Set();
          for (let r = 0; r < pack.bins[at + 1]; r++) {
            const run = (runStart + pack.bins[at] + r) * 4;
            for (let k = 0; k < pack.runs[run + 2]; k++)
              listed.add(pack.runs[run + 1] + k);
          }
          const left = x0 + column * bin;
          const bottom = y0 + row * bin;
          for (
            let s = 0;
            s <
            (tile + 1 < pack.count
              ? pack.styles[(tile + 1) * STYLE_TEXELS * 4 + 14]
              : pack.segments.length / 4) -
              segmentStart;
            s++
          ) {
            const g = (segmentStart + s) * 4;
            const [ax, ay, bx, by] = pack.segments.slice(g, g + 4);
            // The segment's distance to the bin's square.
            let near = Infinity;
            for (let t = 0; t <= 16; t++) {
              const px = ax + ((bx - ax) * t) / 16;
              const py = ay + ((by - ay) * t) / 16;
              const dx = Math.max(left - px, 0, px - left - bin);
              const dy = Math.max(bottom - py, 0, py - bottom - bin);
              near = Math.min(near, Math.hypot(dx, dy));
            }
            // The least margin of any item: a 2 px one (1.5 px of reach)
            // or a 30 m one (0.5 px, the reference, and 15 m).
            const margin =
              Math.min(
                (MARGIN_RATIO * bin * 1.5) / reference,
                MARGIN_RATIO * bin + 15,
              ) +
              EPSILON_M * 0.5;
            if (near < margin)
              assert.ok(
                listed.has(s),
                `tile ${tile} level ${z} bin ${column},${row} misses segment ${s}`,
              );
          }
        }
    }
  }
});

test("tiles' cells split the set's region: one tile holds each point", () => {
  const checked = items('corridor', [
    ...lines(400, { lon: -179.9, lat: 60, spread: 0.3, step: 0.02 }),
    ...lines(400, { lon: 179.7, lat: 60.1, spread: 0.2, step: 0.02 }),
  ]);
  // Few pieces a tile: many tiles.
  const pack = packSet('corridor', checked, { tilePieces: 300 });
  assert.ok(pack.count > 8, `${pack.count} tiles`);
  const cells = [];
  for (let tile = 0; tile < pack.count; tile++) {
    const at = tile * STYLE_TEXELS * 4;
    cells.push([
      ...pack.styles.slice(at, at + 8),
      ...pack.styles.slice(at + 20, at + 22),
    ]);
  }
  let seed = 3;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let k = 0; k < 2000; k++) {
    // Inside the set's bounds and beyond them (open sides).
    const lon = 179.4 + next() * 1.3;
    const lat = 59.8 + next() * 0.7;
    const world = geo.cartesian3.fromDegrees(lon, lat, next() * 500);
    const sinLat = world.z / Math.hypot(world.x, world.y, world.z);
    const holders = cells.filter(
      (c) =>
        world.x * c[0] + world.y * c[1] + c[8] >= 0 &&
        world.x * c[2] + world.y * c[3] + c[9] > 0 &&
        sinLat >= c[4] &&
        sinLat < c[5],
    );
    assert.equal(holders.length, 1, `${lon}, ${lat}: ${holders.length} tiles`);
  }
});

test("a corridor item's look packs for the shader", () => {
  const [item] = items('corridor', [
    {
      positions: [
        [0, 0],
        [0.01, 0],
      ],
      color: [1, 0, 0, 1],
      widthPx: 9,
      glow: { power: 0.25 },
      pulse: { periodMs: 1600, min: 0.35, max: 0.75 },
      dash: {
        cells: 64,
        duty: 0.46,
        speed: 0.55,
        gapAlpha: 0.18,
        emission: 0.9,
      },
    },
  ]);
  const pack = packSet('corridor', [item]);
  const look = [...pack.items];
  assert.deepEqual(look.slice(0, 4), [1, 0, 0, 1]);
  assert.equal(look[4], 9);
  assert.ok(Math.abs(look[6] - 1113) < 5, `length ${look[6]}`);
  assert.equal(look[7], LOOK.glow | LOOK.pulse | LOOK.dash);
  assert.ok(Math.abs(look[8] - 0.25) < 1e-6);
  assert.equal(look[9], 1, 'no taper');
  assert.ok(Math.abs(look[10] - 1.6) < 1e-6);
  assert.ok(Math.abs(look[11] - 0.35) < 1e-6);
  assert.ok(Math.abs(look[12] - 0.75) < 1e-6);
  assert.deepEqual(
    look.slice(13, 16).map((v) => +v.toFixed(2)),
    [64, 0.46, 0.55],
  );
  assert.deepEqual(
    look.slice(16, 18).map((v) => +v.toFixed(2)),
    [0.18, 0.9],
  );
});

test('heights are sampled again without packing the set again', () => {
  const checked = items('corridor', lines(20));
  const pack = packSet('corridor', checked);
  assert.ok(pack.heights.every(Number.isNaN));
  const heights = packHeights(pack, { terrainHeight: () => 25 });
  assert.deepEqual([...heights], Array(pack.count * 2).fill(25));
});

test('sampled terrain heights bound the screen box; unknown ones keep it deep', () => {
  const square = items('polygon', [
    {
      rings: [
        [
          [55, 25],
          [55.01, 25],
          [55.01, 25.01],
          [55, 25.01],
        ],
      ],
      fill: [1, 1, 1, 1],
    },
  ]);
  const sampled = packSet('polygon', square, { terrainHeight: () => 40 });
  assert.deepEqual([...sampled.heights], [40, 40]);
  const unknown = packSet('polygon', square, {
    terrainHeight: (lon) => (lon > 55.005 ? undefined : 10),
  });
  assert.ok(unknown.heights.every(Number.isNaN));
  assert.ok(packSet('polygon', square).heights.every(Number.isNaN));
});

test('a large area bins its segments; each bin knows its centre', () => {
  // A ring of 200 segments round a 10 km circle.
  const list = [];
  for (let index = 0; index < 200; index++) {
    const a = (index / 200) * 2 * Math.PI;
    const b = ((index + 1) / 200) * 2 * Math.PI;
    list.push(
      5000 * Math.cos(a),
      5000 * Math.sin(a),
      5000 * Math.cos(b),
      5000 * Math.sin(b),
    );
  }
  assert.equal(binArea(list.slice(0, 4 * BIN_THRESHOLD)), null);
  const grid = binArea(list);
  assert.equal(grid.columns, grid.rows);
  const at = (x, y) =>
    grid.bins[
      Math.floor((y - grid.y) / grid.size) * grid.columns +
        Math.floor((x - grid.x) / grid.size)
    ];
  assert.equal(at(0, 0).inside, 1, 'the middle is inside');
  assert.equal(at(0, 0).count, 0, 'and far from every edge');
  assert.equal(at(grid.x + 1, grid.y + 1).inside, 0, 'a corner is outside');
  assert.ok(at(5000, 0).count > 0, 'the rim bins hold its edges');
  // A ring through a pixel's neighbourhood is in its bin's list.
  const total = grid.bins.reduce((sum, bin) => sum + bin.count, 0);
  assert.ok(total >= 200 && total < 200 * 6, `${total} entries`);
});

test('each bin of a packed area points at its own segments', () => {
  const ring = Array.from({ length: 80 }, (_, index) => {
    const angle = (index / 80) * 2 * Math.PI;
    return [55 + 0.2 * Math.cos(angle), 25 + 0.2 * Math.sin(angle)];
  });
  const pack = packSet(
    'polygon',
    items('polygon', [{ rings: [ring], fill: [1, 1, 1, 1] }]),
  );
  const columns = pack.styles[16];
  const rows = pack.styles[17];
  assert.ok(columns * rows > 1);
  assert.equal(pack.bins.length / 4, columns * rows);
  let expected = 80;
  for (let bin = 0; bin < columns * rows; bin++) {
    assert.equal(pack.bins[bin * 4], expected, `bin ${bin} start`);
    expected += pack.bins[bin * 4 + 1];
  }
  assert.equal(pack.segments.length / 4, expected);
});

test('screen-space dash masks keep their CSS length and all sixteen bits in the pass', () => {
  const pack = packSet(
    'corridor',
    items('corridor', [
      {
        positions: [
          [85, 28],
          [85.1, 28.1],
        ],
        color: [0.8, 0.5, 0.3, 0.38],
        widthPx: 18,
        dashPattern: { lengthPx: 18, pattern: 0xa55a },
      },
    ]),
  );
  assert.equal(pack.items[7], LOOK.pattern);
  assert.deepEqual(Array.from(pack.items.slice(18, 20)), [18, 0xa55a]);
  assert.equal(pack.items.length, ITEM_TEXELS * 4);
});

test('radial discs pack both transitions, alpha and emission without segment data', () => {
  const radial = {
    fillAlpha: 0.105,
    rimAlpha: 0.72,
    rimStart: 0.952,
    rimEnd: 0.985,
    emission: 0.35,
  };
  const pack = packSet(
    'disc',
    items('disc', [
      { center: [20, 10], radiusM: 100, fill: [0, 1, 1, 1], radial },
    ]),
  );
  assert.equal(pack.styles[10], 1);
  assert.deepEqual(
    Array.from(pack.styles.slice(16, 21)),
    Array.from(Float32Array.of(0.105, 0.72, 0.952, 0.985, 0.35)),
  );
  assert.equal(pack.segments.length, 0);
});

test('screen padding follows the render pixel ratio', () => {
  const pack = packSet(
    'disc',
    items('disc', [
      {
        center: [0, 0],
        radiusM: 100,
        outline: { color: [1, 1, 1, 1], widthPx: 8 },
      },
    ]),
  );
  const state = composeGround([pack]);
  const identity = geo.matrix4.IDENTITY;
  state.update(identity, identity, 800, 600, 1);
  const padding = state.frames.data[11];
  assert.equal(state.update(identity, identity, 800, 600, 2), true);
  assert.equal(state.frames.data[11], padding * 2);
});
