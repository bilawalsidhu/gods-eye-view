import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  isViewRef,
  viewLayout,
  viewUniforms,
  VIEW_RINGS_MAX,
} from './viewSheet.js';
import { AIRCRAFT_VIEWS } from './aircraftViews.js';

const layout = viewLayout(AIRCRAFT_VIEWS.sheet);
const RAD = Math.PI / 180;
/** The pinned layout: rings 7.5° apart, 302 frames a subject. */
const RINGS = [1, 4, 7, 10, 13, 16, 18, 20, 22, 23, 24, 25, 25, 25, 24, 23, 22];
const FIRSTS = [
  0, 1, 5, 12, 22, 35, 51, 69, 89, 111, 134, 158, 183, 208, 233, 257, 280,
];

test('viewLayout gives the aircraft sheet each ring’s first frame', () => {
  assert.deepEqual(layout.rings, RINGS);
  assert.deepEqual(layout.firsts, FIRSTS);
  assert.equal(layout.frames, 302);
  assert.equal(layout.cellPx, 64);
  assert.equal(layout.columns, 64);
  assert.equal(layout.rows, 57);
  assert.equal(layout.ringStepRad, 7.5 * RAD);
  assert.notEqual(layout.rings, AIRCRAFT_VIEWS.sheet.rings, 'a copy');
});

test('viewLayout refuses a sheet it cannot draw', () => {
  const sheet = AIRCRAFT_VIEWS.sheet;
  const bad = [
    null,
    { ...sheet, image: '' },
    { ...sheet, image: undefined },
    { ...sheet, cellPx: 63.5 },
    { ...sheet, columns: 0 },
    { ...sheet, rows: -32 },
    { ...sheet, rings: [] },
    { ...sheet, rings: 'many' },
    { ...sheet, rings: Array(VIEW_RINGS_MAX + 1).fill(1) },
    { ...sheet, rings: [3, 5] },
    { ...sheet, rings: [1, 2.5] },
    { ...sheet, rings: [1, 0] },
    { ...sheet, ringStepDeg: 0 },
    { ...sheet, ringStepDeg: -15 },
    { ...sheet, ringStepDeg: Number.NaN },
    { ...sheet, ringStepDeg: Infinity },
    // A ring straight below, or past it.
    { ...sheet, rings: [1, 4, 4, 1], ringStepDeg: 60 },
    { ...sheet, rings: Array(13).fill(1), ringStepDeg: 15 },
  ];
  for (const sheetGiven of bad)
    assert.throws(
      () => viewLayout(sheetGiven),
      TypeError,
      JSON.stringify(sheetGiven),
    );
  // Short of straight below, and the most rings there may be, are drawn.
  assert.equal(viewLayout({ ...sheet, rings: Array(12).fill(1) }).frames, 12);
  assert.equal(
    viewLayout({
      ...sheet,
      rings: Array(VIEW_RINGS_MAX).fill(1),
      ringStepDeg: 10,
    }).rings.length,
    VIEW_RINGS_MAX,
  );
});

test('viewUniforms packs the layout as the shader reads it', () => {
  const { grid, rings } = viewUniforms(layout);
  assert.deepEqual(grid, [64, 57, 7.5 * RAD, 17]);
  // Two rings a vector: each ring's frames and its first frame.
  assert.equal(rings.length, VIEW_RINGS_MAX / 2);
  const pairs = [];
  for (let k = 0; k < RINGS.length; k += 2)
    pairs.push([RINGS[k], FIRSTS[k], RINGS[k + 1] ?? 1, FIRSTS[k + 1] ?? 0]);
  assert.deepEqual(rings.slice(0, pairs.length), pairs);
  for (const pair of rings.slice(pairs.length))
    assert.deepEqual(pair, [1, 0, 1, 0], 'padding');
});

test('AIRCRAFT_VIEWS is consistent: a block a subject, every block on the sheet', () => {
  const { sheet, frames, subjects } = AIRCRAFT_VIEWS;
  assert.equal(frames, 302);
  assert.equal(sheet.cellPx * sheet.columns, 4096);
  assert.equal(sheet.cellPx * sheet.rows, 3648);
  for (const first of Object.values(subjects))
    assert.ok(first + frames <= sheet.columns * sheet.rows, 'on the sheet');
  assert.ok(Object.isFrozen(AIRCRAFT_VIEWS));
  assert.ok(Object.isFrozen(sheet));
  assert.ok(Object.isFrozen(sheet.rings));
  assert.ok(Object.isFrozen(subjects));
});

const SHEET = new URL(
  '../../public/sprites/aircraft-views.webp',
  import.meta.url,
);

test(
  'the shipped sheet is the size the layout says, grey, lit in every used cell and clear at its edge',
  async () => {
    const { default: sharp } = await import('sharp');
    const { sheet, frames, subjects } = AIRCRAFT_VIEWS;
    const { data, info } = await sharp(fileURLToPath(SHEET))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(info.width, sheet.columns * sheet.cellPx);
    assert.equal(info.height, sheet.rows * sheet.cellPx);
    const at = (x, y) => (y * info.width + x) * 4;
    // Grey: the renderer reads the red channel as the grey.
    for (let i = 0; i < data.length; i += 4)
      if (data[i] !== data[i + 1] || data[i] !== data[i + 2])
        assert.fail(`not grey at pixel ${i / 4}`);
    // Each used cell keeps its outer 2 px transparent (the mipmaps).
    const used = Object.keys(subjects).length * frames;
    const c = sheet.cellPx;
    for (let n = 0; n < used; n++) {
      const left = (n % sheet.columns) * c;
      const top = Math.floor(n / sheet.columns) * c;
      let lit = 0;
      for (let y = 0; y < c; y++)
        for (let x = 0; x < c; x++) {
          if (!data[at(left + x, top + y) + 3]) continue;
          lit++;
          if (x >= 2 && y >= 2 && x < c - 2 && y < c - 2) continue;
          assert.fail(`cell ${n}: alpha at its edge (${x}, ${y})`);
        }
      if (!lit) assert.fail(`cell ${n}: empty`);
    }
  },
);

test('a view ref is told apart from flat images', () => {
  assert.equal(isViewRef({ views: 'test', first: 0 }), true);
  for (const image of [
    'data:image/svg+xml;base64,AAA',
    null,
    undefined,
    { atlas: 'a', slot: 's' },
  ])
    assert.equal(isViewRef(image), false, String(image));
});
