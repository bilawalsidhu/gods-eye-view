import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  AIRCRAFT_VIEWS,
  frameDirection,
  frameUp,
  viewFrame,
  viewLayout,
  viewUniforms,
  VIEW_RINGS_MAX,
} from './viewSheet.js';

const layout = viewLayout(AIRCRAFT_VIEWS.sheet);
const RAD = Math.PI / 180;
const HORIZON = 12; // the ring at 90° from straight above
/** The pinned layout: rings 7.5° apart, 302 frames a subject. */
const RINGS = [1, 4, 7, 10, 13, 16, 18, 20, 22, 23, 24, 25, 25, 25, 24, 23, 22];
const FIRSTS = [
  0, 1, 5, 12, 22, 35, 51, 69, 89, 111, 134, 158, 183, 208, 233, 257, 280,
];

/** A unit `[forward, right, up]` `offDeg` from straight above, at `bearingDeg`
 *  from dead ahead toward the right side. */
function direction(offDeg, bearingDeg) {
  const off = offDeg * RAD;
  const bearing = bearingDeg * RAD;
  return [
    Math.sin(off) * Math.cos(bearing),
    Math.sin(off) * Math.sin(bearing),
    Math.cos(off),
  ];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const mirror = (v) => [v[0], -v[1], v[2]];
const near = (a, b, eps = 1e-9) =>
  a.every((value, i) => Math.abs(value - b[i]) < eps);

/** The smallest rotation taking up onto `d`, applied to forward (Rodrigues). */
function rotatedForward(d) {
  const up = [0, 0, 1];
  const forward = [1, 0, 0];
  const axis = cross(up, d);
  const sin = Math.hypot(...axis);
  const cos = dot(up, d);
  if (sin < 1e-12) return forward;
  const k = axis.map((value) => value / sin);
  const kxv = cross(k, forward);
  const kv = dot(k, forward);
  return forward.map(
    (value, i) => value * cos + kxv[i] * sin + k[i] * kv * (1 - cos),
  );
}

test('viewLayout gives the aircraft sheet each ring’s first frame', () => {
  assert.deepEqual(layout.rings, RINGS);
  assert.deepEqual(layout.firsts, FIRSTS);
  assert.equal(layout.frames, 302);
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

test('straight above is frame 0, whatever the course', () => {
  assert.deepEqual(viewFrame(layout, [0, 0, 1]), {
    frame: 0,
    ring: 0,
    index: 0,
    mirrored: false,
  });
  assert.equal(viewFrame(layout, [0, 0, 42]).frame, 0, 'any length');
  assert.equal(viewFrame(layout, direction(3.7, 135)).frame, 0);
  assert.equal(viewFrame(layout, [0, 0, 0]).frame, 0, 'no direction: above');
});

test('on the horizon, dead ahead, abeam and astern are the first, middle and last frames of ring 12', () => {
  const first = layout.firsts[HORIZON];
  const ahead = viewFrame(layout, [1, 0, 0]);
  assert.deepEqual(ahead, {
    frame: first,
    ring: 12,
    index: 0,
    mirrored: false,
  });
  assert.deepEqual(viewFrame(layout, [0, 1, 0]), {
    frame: first + 12,
    ring: 12,
    index: 12,
    mirrored: false,
  });
  assert.deepEqual(viewFrame(layout, [-1, 0, 0]), {
    frame: first + 24,
    ring: 12,
    index: 24,
    mirrored: false,
  });
});

test('the left side draws the right side’s frame mirrored', () => {
  for (const [off, bearing] of [
    [30, 40],
    [90, 90],
    [105, 170],
    [60, 1],
  ]) {
    const right = viewFrame(layout, direction(off, bearing));
    const left = viewFrame(layout, mirror(direction(off, bearing)));
    assert.equal(left.frame, right.frame, `${off}/${bearing}`);
    assert.equal(right.mirrored, false);
    assert.equal(left.mirrored, true);
  }
  // Exactly on the centre plane it is not mirrored.
  assert.equal(viewFrame(layout, [1, 0, 0]).mirrored, false);
  assert.equal(viewFrame(layout, [1, -0, 0]).mirrored, false);
});

test('below the last ring the eye takes the last ring', () => {
  const last = layout.rings.length - 1;
  for (const off of [120, 126, 135, 170, 180]) {
    const view = viewFrame(layout, direction(off, 90));
    assert.equal(view.ring, last, `${off}°`);
  }
  assert.equal(viewFrame(layout, [0, 0, -1]).frame, layout.firsts[last]);
});

test('frames round to the nearest, between rings and between bearings', () => {
  // Rings are 7.5° apart: 3.75° from straight above is between ring 0 and 1.
  assert.equal(viewFrame(layout, direction(3.7, 0)).ring, 0);
  assert.equal(viewFrame(layout, direction(3.8, 0)).ring, 1);
  assert.equal(viewFrame(layout, direction(86.2, 0)).ring, 11);
  assert.equal(viewFrame(layout, direction(86.3, 0)).ring, 12);
  // The horizon ring's 25 frames are 7.5° of bearing apart.
  assert.equal(viewFrame(layout, direction(90, 3.7)).index, 0);
  assert.equal(viewFrame(layout, direction(90, 3.8)).index, 1);
  assert.equal(viewFrame(layout, direction(90, 176.2)).index, 23);
  assert.equal(viewFrame(layout, direction(90, 176.3)).index, 24);
  // Ring 1's 4 frames are 60° apart.
  assert.equal(viewFrame(layout, direction(7.5, 29.9)).index, 0);
  assert.equal(viewFrame(layout, direction(7.5, 30.1)).index, 1);
});

test('frameDirection is where viewFrame finds each frame of the sheet', () => {
  let frames = 0;
  for (let ring = 0; ring < layout.rings.length; ring++)
    for (let index = 0; index < layout.rings[ring]; index++) {
      for (const mirrored of [false, true]) {
        const d = frameDirection(layout, ring, index, mirrored);
        assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-12, 'unit');
        const view = viewFrame(layout, d);
        assert.equal(view.ring, ring, `${ring}/${index}`);
        assert.equal(view.index, index, `${ring}/${index}`);
        assert.equal(view.frame, layout.firsts[ring] + index);
        // A frame on the centre plane is its own mirror image: either way
        // draws it.
        if (Math.abs(d[1]) > 1e-12) assert.equal(view.mirrored, mirrored);
      }
      frames++;
    }
  assert.equal(frames, AIRCRAFT_VIEWS.frames);
});

test('frameUp is a unit vector across the view, forward from straight above, and turns as the smallest rotation does', () => {
  assert.ok(near(frameUp([0, 0, 1]), [1, 0, 0]), 'nose up the image');
  for (let ring = 0; ring < layout.rings.length; ring++)
    for (let index = 0; index < layout.rings[ring]; index++)
      for (const mirrored of [false, true]) {
        const d = frameDirection(layout, ring, index, mirrored);
        const up = frameUp(d);
        const at = `${ring}/${index}${mirrored ? ' mirrored' : ''}`;
        assert.ok(Math.abs(Math.hypot(...up) - 1) < 1e-9, `unit at ${at}`);
        assert.ok(Math.abs(dot(up, d)) < 1e-9, `across the view at ${at}`);
        assert.ok(
          near(up, rotatedForward(d)),
          `the smallest rotation at ${at}`,
        );
        // Mirroring the eye mirrors the image's up.
        assert.ok(near(frameUp(mirror(d)), mirror(up)), `mirrored at ${at}`);
      }
  // On the horizon, abeam: the nose still points up the image.
  assert.ok(near(frameUp([0, 1, 0]), [1, 0, 0]));
  // Dead ahead on the horizon: the image's up is straight down the aircraft.
  assert.ok(near(frameUp([1, 0, 0]), [0, 0, -1]));
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
  assert.equal(
    frames,
    sheet.rings.reduce((a, b) => a + b, 0),
  );
  assert.equal(frames, 302);
  assert.equal(sheet.cellPx * sheet.columns, 4096);
  assert.equal(sheet.cellPx * sheet.rows, 3648);
  assert.equal(sheet.grey, true, 'kept as grey and alpha');
  const firsts = Object.values(subjects);
  firsts.forEach((first, i) => {
    assert.equal(first, i * frames, 'in order, one block after another');
    assert.equal(first % frames, 0);
    assert.ok(first + frames <= sheet.columns * sheet.rows, 'on the sheet');
  });
  assert.ok(Object.isFrozen(AIRCRAFT_VIEWS));
  assert.ok(Object.isFrozen(sheet));
  assert.ok(Object.isFrozen(sheet.rings));
  assert.ok(Object.isFrozen(subjects));
});

const BAKE = new URL(
  '../../scripts/build-aircraft-view-sheet.py',
  import.meta.url,
);
const MANIFEST = new URL(
  '../../public/sprites/aircraft-views.json',
  import.meta.url,
);

test('the bake script lays the sheet out as AIRCRAFT_VIEWS says', () => {
  const script = readFileSync(BAKE, 'utf8');
  const constant = (name) => {
    const match = new RegExp(`^${name} = (.+)$`, 'm').exec(script);
    assert.ok(match, `${name} in the bake script`);
    return JSON.parse(match[1]);
  };
  const { sheet, frames, subjects } = AIRCRAFT_VIEWS;
  assert.equal(constant('RING_STEP_DEG'), sheet.ringStepDeg);
  assert.deepEqual(constant('RINGS'), [...sheet.rings]);
  assert.equal(constant('COLUMNS'), sheet.columns);
  const list = /^SUBJECTS = \[([\s\S]*?)^\]/m.exec(script);
  assert.ok(list, 'SUBJECTS in the bake script');
  const names = [...list[1].matchAll(/^\s*\("(\w+)",/gm)].map((m) => m[1]);
  assert.deepEqual(names, Object.keys(subjects), 'the same subjects in order');
  // The script's rows: as many as its subjects' blocks take.
  assert.equal(Math.ceil((names.length * frames) / sheet.columns), sheet.rows);
});

test(
  'the baked manifest matches AIRCRAFT_VIEWS',
  { skip: !existsSync(MANIFEST) && 'no public/sprites/aircraft-views.json' },
  () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const { sheet, subjects } = AIRCRAFT_VIEWS;
    assert.equal(manifest.cellPx, sheet.cellPx);
    assert.equal(manifest.columns, sheet.columns);
    assert.equal(manifest.rows, sheet.rows);
    assert.equal(manifest.ringStepDeg, sheet.ringStepDeg);
    assert.deepEqual(manifest.rings, [...sheet.rings]);
    assert.equal(manifest.grey, true);
    assert.equal(manifest.image, 'aircraft-views.webp');
    assert.deepEqual(Object.keys(manifest.subjects), Object.keys(subjects));
    for (const [name, first] of Object.entries(subjects))
      assert.equal(manifest.subjects[name].first, first, name);
  },
);

const SHEET = new URL(
  '../../public/sprites/aircraft-views.webp',
  import.meta.url,
);

test(
  'the shipped sheet is the size the layout says, grey, and clear at every cell’s edge',
  { skip: !existsSync(SHEET) && 'no public/sprites/aircraft-views.webp' },
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
      for (let y = 0; y < c; y++)
        for (let x = 0; x < c; x++) {
          if (x >= 2 && y >= 2 && x < c - 2 && y < c - 2) continue;
          if (data[at(left + x, top + y) + 3] !== 0)
            assert.fail(`cell ${n}: alpha at its edge (${x}, ${y})`);
        }
    }
  },
);

test('in the bake’s axes (nose −X, starboard +Y, up +Z) a frame has the same up and direction', () => {
  // The bake turns forward by Blender's rotation_difference(UP, d), in its
  // own axes, which are mirrored from [forward, right, up]: the smallest
  // rotation is the same rotation in either.
  const toBake = (v) => [-v[0], v[1], v[2]];
  const minimal = (from, to, v) => {
    const axis = cross(from, to);
    const sin = Math.hypot(...axis);
    const cos = dot(from, to);
    if (sin < 1e-12) return v;
    const k = axis.map((value) => value / sin);
    const kxv = cross(k, v);
    const kv = dot(k, v);
    return v.map(
      (value, i) => value * cos + kxv[i] * sin + k[i] * kv * (1 - cos),
    );
  };
  for (let ring = 0; ring < layout.rings.length; ring++)
    for (let index = 0; index < layout.rings[ring]; index++) {
      const d = frameDirection(layout, ring, index);
      const bakeUp = minimal([0, 0, 1], toBake(d), toBake([1, 0, 0]));
      assert.ok(near(toBake(frameUp(d)), bakeUp), `${ring}/${index}`);
    }
});

/** A blend's weight by frame (a frame listed twice counts once, summed). */
