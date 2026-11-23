#!/usr/bin/env node
/**
 * qa-view-sheet.mjs: contact sheets of a baked view sheet (aircraft or
 * vessels), for reviewing a bake (`scripts/bake-view-sheet.py`) before it
 * ships.
 *
 * For each subject it writes one image: its frames with the rings as rows
 * (straight above at the top, the last ring at the bottom, each ring from
 * dead ahead to dead astern), in white, over three grounds the subject is
 * seen over. Under them, a few frames (above, oblique, abeam, and below or
 * low on the horizon) shrunk to the sizes a contact is drawn at, in each
 * tint the layers draw it with, to judge whether thin wings and hulls still
 * read. Aircraft: a dark sea, pale land and a mid satellite tone; the fleet,
 * tracked and military tints. Vessels: a dark sea, pale shallow water and a
 * satellite ocean tone; white and the colour of each kind the subject is
 * drawn for (`VESSEL_KIND_STYLES`).
 *
 * Run:  node scripts/qa-view-sheet.mjs [--manifest public/sprites/aircraft-views.json]
 *         [--sheet <image>] [--out qa-shots/<name>] [--zoom 2] [--sizes 40,30,20]
 *         [--only airliner,glider]
 * `--sheet` defaults to the manifest's `image`, next to it.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { VESSEL_KIND_STYLES } from '../src/data/vesselTypes.js';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const MANIFEST = path.resolve(
  opt('--manifest', 'public/sprites/aircraft-views.json'),
);
const ZOOM = Number(opt('--zoom', '2'));
const SIZES = opt('--sizes', '40,30,20').split(',').map(Number);
const ONLY = opt('--only', '').split(',').filter(Boolean);

const GAP = 8;

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const VESSELS = manifest.image.startsWith('vessel');
const OUT = path.resolve(
  opt('--out', `qa-shots/${path.basename(manifest.image, '.webp')}`),
);
const WHITE = { name: 'white', rgb: [1, 1, 1] };
/** `#rrggbb` as 0..1 channels. */
const rgbOf = (css) =>
  [1, 3, 5].map((i) => parseInt(css.slice(i, i + 2), 16) / 255);
/** Grounds a contact is seen over. */
const GROUNDS = VESSELS
  ? [
      { name: 'sea', css: '#1f3a4f' },
      { name: 'shallows', css: '#8fc3c1' },
      { name: 'satellite', css: '#0f2e44' },
    ]
  : [
      { name: 'sea', css: '#1f3a4f' },
      { name: 'land', css: '#d9d2bd' },
      { name: 'satellite', css: '#6f7559' },
    ];
/** The kinds a vessel shape that is not a kind of its own is coloured as: a
 *  vessel takes its kind's colour (`vesselKind`), whatever its shape. */
const SHAPE_KINDS = { dredger: ['other'], pilot: ['tug', 'military'] };
/** A subject's tints, multiplied into the neutral sprite as the layers do. */
const tintsOf = (name) =>
  VESSELS
    ? [
        WHITE,
        ...(SHAPE_KINDS[name] ?? [name]).map((kind) => ({
          name: kind,
          rgb: rgbOf(VESSEL_KIND_STYLES[kind].css),
        })),
      ]
    : [
        WHITE,
        { name: 'tracked', rgb: [0.22, 0.82, 1] },
        { name: 'military', rgb: [1, 0.72, 0] },
      ];
const sheetPath = path.resolve(
  opt('--sheet', path.join(path.dirname(MANIFEST), manifest.image)),
);
const { cellPx: cell, columns, rings } = manifest;
const firsts = [];
rings.reduce((at, count) => (firsts.push(at), at + count), 0);
const widest = Math.max(...rings);
/** The ring nearest `offDeg` from straight above. */
const ringAt = (offDeg) =>
  Math.min(rings.length - 1, Math.round(offDeg / manifest.ringStepDeg));
const last = rings.length - 1;
/** Frames shown shrunk, as ring and index: straight above, oblique from
 *  ahead and to the right, abeam on the horizon, and the last ring from
 *  below abeam or, if the last ring is the horizon, from the bow quarter. */
const PICKS = [
  [0, 0],
  [ringAt(45), Math.floor((rings[ringAt(45)] - 1) / 3)],
  [ringAt(90), Math.round((rings[ringAt(90)] - 1) / 2)],
  last === ringAt(90)
    ? [last, Math.round((rings[last] - 1) / 4)]
    : [last, Math.round((rings[last] - 1) / 2)],
];

const sheet = sharp(sheetPath, { limitInputPixels: false });
const { data: pixels, info } = await sheet
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

/** One cell as raw RGBA, tinted. */
function cellPixels(index, tint) {
  const out = Buffer.alloc(cell * cell * 4);
  const left = (index % columns) * cell;
  const top = Math.floor(index / columns) * cell;
  for (let y = 0; y < cell; y++)
    for (let x = 0; x < cell; x++) {
      const from = ((top + y) * info.width + left + x) * 4;
      const to = (y * cell + x) * 4;
      for (let c = 0; c < 3; c++)
        out[to + c] = Math.round(pixels[from + c] * tint.rgb[c]);
      out[to + 3] = pixels[from + 3];
    }
  return out;
}

async function cellImage(index, tint, size) {
  let image = sharp(cellPixels(index, tint), {
    raw: { width: cell, height: cell, channels: 4 },
  });
  if (size !== cell) image = image.resize(size, size, { kernel: 'lanczos3' });
  else if (ZOOM !== 1)
    image = image.resize(cell * ZOOM, cell * ZOOM, { kernel: 'nearest' });
  return image.png().toBuffer();
}

async function subjectSheet(name, first) {
  const TINTS = tintsOf(name);
  const tile = cell * ZOOM;
  const panelW = widest * tile;
  const panelH = rings.length * tile;
  const stripH = Math.max(...SIZES) + GAP;
  const blockH = panelH + GAP + TINTS.length * stripH;
  const width = GROUNDS.length * (panelW + GAP) + GAP;
  const height = blockH + 2 * GAP;
  const layers = [];
  for (const [g, ground] of GROUNDS.entries()) {
    const x0 = GAP + g * (panelW + GAP);
    layers.push({
      input: {
        create: {
          width: panelW,
          height: blockH,
          channels: 4,
          background: ground.css,
        },
      },
      left: x0,
      top: GAP,
    });
    // Rings as rows, white.
    for (let ring = 0; ring < rings.length; ring++)
      for (let i = 0; i < rings[ring]; i++)
        layers.push({
          input: await cellImage(first + firsts[ring] + i, WHITE, cell),
          left: x0 + i * tile,
          top: GAP + ring * tile,
        });
    // The picked frames shrunk to drawn sizes, one row a tint.
    for (const [t, tint] of TINTS.entries()) {
      let x = x0 + GAP;
      const y = GAP + panelH + GAP + t * stripH;
      for (const [ring, index] of PICKS)
        for (const size of SIZES) {
          layers.push({
            input: await cellImage(first + firsts[ring] + index, tint, size),
            left: x,
            top: y + (stripH - GAP - size),
          });
          x += size + 4;
        }
    }
  }
  const file = path.join(OUT, `${name}.png`);
  await sharp({
    create: { width, height, channels: 4, background: '#111111' },
  })
    .composite(layers)
    .png()
    .toFile(file);
  return file;
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, entry] of Object.entries(manifest.subjects)) {
  if (ONLY.length && !ONLY.includes(name)) continue;
  const first = typeof entry === 'number' ? entry : entry.first;
  console.log('wrote', await subjectSheet(name, first));
}
