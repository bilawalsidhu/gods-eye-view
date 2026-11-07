import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../../geo/index.js';
import { normalizeGroundItem } from '../../ground.js';
import {
  BIN_THRESHOLD,
  binArea,
  composeGround,
  CORRIDOR_CHUNK,
  GRID_COLS,
  KIND,
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
  const [ax, ay, bx, by] = corridor.segments;
  assert.ok(Math.abs(ay) < 1e-6 && Math.abs(by) < 1e-6, 'on the equator');
  assert.ok(Math.abs(ax + bx) < 1e-6);
  assert.equal(corridor.styles[8], KIND.corridorPx);
  assert.equal(corridor.styles[10], 4);
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

test('a long corridor packs as chunks that own their own segments', () => {
  const positions = Array.from({ length: 41 }, (_, index) => [index * 0.01, 0]);
  const pack = packSet(
    'corridor',
    items('corridor', [{ positions, color: [1, 1, 1, 1], widthM: 10 }]),
  );
  assert.equal(pack.count, Math.ceil(40 / CORRIDOR_CHUNK));
  const owned = (index) => [
    ...pack.styles.slice(
      index * STYLE_TEXELS * 4 + 16,
      index * STYLE_TEXELS * 4 + 18,
    ),
  ];
  const counts = (index) => pack.styles[index * STYLE_TEXELS * 4 + 15];
  // The first chunk has no segment before it, the others one each side.
  assert.deepEqual(owned(0), [0, CORRIDOR_CHUNK]);
  assert.equal(counts(0), CORRIDOR_CHUNK + 1);
  assert.deepEqual(owned(1), [1, CORRIDOR_CHUNK]);
  assert.equal(counts(1), CORRIDOR_CHUNK + 2);
  const last = pack.count - 1;
  const rest = 40 - last * CORRIDOR_CHUNK;
  assert.deepEqual(owned(last), [1, rest]);
  assert.equal(counts(last), rest + 1);
  assert.equal(pack.styles[8], KIND.corridorM);
  assert.equal(pack.styles[11], 10);
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
