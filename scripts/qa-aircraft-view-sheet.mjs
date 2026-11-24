#!/usr/bin/env node
/**
 * qa-aircraft-view-sheet.mjs: contact sheets of a baked aircraft view sheet,
 * for reviewing a bake (`scripts/build-aircraft-view-sheet.py`) before it
 * ships.
 *
 * For each subject it writes one image: its frames with the rings as rows
 * (straight above at the top, 30° below the horizon at the bottom, each ring
 * from dead ahead to dead astern), over a dark sea colour, a pale land colour
 * and a mid satellite tone, each tinted as the layers tint it. Under them, a
 * few frames (above, oblique, abeam, below) shrunk to the sizes a contact is
 * drawn at, to judge whether thin wings still read.
 *
 * Run:  node scripts/qa-aircraft-view-sheet.mjs [--manifest public/sprites/aircraft-views.json]
 *         [--sheet <image>] [--out qa-shots/aircraft-views] [--zoom 2] [--sizes 40,30,20]
 *         [--only airliner,glider]
 * `--sheet` defaults to the manifest's `image`, a file next to it.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const MANIFEST = path.resolve(
  opt('--manifest', 'public/sprites/aircraft-views.json'),
);
const OUT = path.resolve(opt('--out', 'qa-shots/aircraft-views'));
const ZOOM = Number(opt('--zoom', '2'));
const SIZES = opt('--sizes', '40,30,20').split(',').map(Number);
const ONLY = opt('--only', '').split(',').filter(Boolean);

/** Grounds a contact is seen over: a dark sea, pale land, a mid satellite tone. */
const GROUNDS = [
  { name: 'sea', css: '#1f3a4f' },
  { name: 'land', css: '#d9d2bd' },
  { name: 'satellite', css: '#6f7559' },
];
/** The layers' tints, multiplied into the neutral sprite. */
const TINTS = [
  { name: 'fleet', rgb: [1, 1, 1] },
  { name: 'military', rgb: [1, 0.72, 0] },
];
const GAP = 8;

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
for (const name of Object.keys(manifest.subjects))
  if (!/^[\w-]+$/.test(name))
    throw new Error(`Invalid subject name: ${JSON.stringify(name)}`);
const override = opt('--sheet', null);
if (
  !override &&
  (typeof manifest.image !== 'string' ||
    !manifest.image ||
    path.basename(manifest.image) !== manifest.image ||
    ['.', '..'].includes(manifest.image))
)
  throw new Error(
    "The manifest's image must be a file next to it. Pass --sheet for another.",
  );
const sheetPath = override ?? path.join(path.dirname(MANIFEST), manifest.image);
const { cellPx: cell, columns, rows, rings } = manifest;
const firsts = [];
rings.reduce((at, count) => (firsts.push(at), at + count), 0);
const widest = Math.max(...rings);
/** The ring nearest `offDeg` from straight above. */
const ringAt = (offDeg) =>
  Math.min(rings.length - 1, Math.round(offDeg / manifest.ringStepDeg));
/** Frames shown shrunk, as ring and index: straight above, oblique from
 *  ahead and to the right, abeam on the horizon, and from below, abeam. */
const PICKS = [
  [0, 0],
  [ringAt(45), Math.floor((rings[ringAt(45)] - 1) / 3)],
  [ringAt(90), Math.round((rings[ringAt(90)] - 1) / 2)],
  [rings.length - 1, Math.round((rings[rings.length - 1] - 1) / 2)],
];

const sheet = sharp(sheetPath);
const meta = await sheet.metadata();
if (meta.width !== columns * cell || meta.height !== rows * cell)
  throw new Error('The sheet dimensions must match the manifest grid.');
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
    // Rings as rows, fleet white.
    for (let ring = 0; ring < rings.length; ring++)
      for (let i = 0; i < rings[ring]; i++)
        layers.push({
          input: await cellImage(first + firsts[ring] + i, TINTS[0], cell),
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
  if (path.dirname(file) !== OUT)
    throw new Error('Invalid subject output path');
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
  console.log('wrote', await subjectSheet(name, entry.first));
}
