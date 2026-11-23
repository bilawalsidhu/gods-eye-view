#!/usr/bin/env node
/**
 * build-view-sheet.mjs: bake a view sheet (aircraft or vessels) and ship it.
 *
 * Runs `scripts/bake-view-sheet.py` in Blender (headless) into a scratch
 * directory, then writes the sheet to `public/sprites/` as
 * `<name>.webp` (lossless WebP of the baked PNG) and `<name>.json` (its
 * manifest): `aircraft-views` or `vessel-views`. See
 * `public/sprites/README.md`.
 *
 * Run:  node scripts/build-view-sheet.mjs --sheet aircraft|vessels
 *         [--only airliner,light] [--out public/sprites]
 *       (npm run build:aircraft-views, npm run build:vessel-views)
 * Blender: `$BLENDER`, else `blender` on the PATH, else the macOS app.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT = path.resolve(root, opt('--out', 'public/sprites'));
const ONLY = opt('--only', null);
const SHEET = opt('--sheet', null);
if (SHEET !== 'aircraft' && SHEET !== 'vessels')
  throw new Error('--sheet is aircraft or vessels');
// A bake of some subjects leaves the others' cells empty: it is for looking
// at, never for the sheet the app loads.
if (ONLY && !argv.includes('--out'))
  throw new Error(
    '--only bakes part of a sheet: give it its own --out, not public/sprites',
  );

function blender() {
  if (process.env.BLENDER) return process.env.BLENDER;
  const which = spawnSync('which', ['blender'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const mac = '/Applications/Blender.app/Contents/MacOS/Blender';
  if (fs.existsSync(mac)) return mac;
  throw new Error('no Blender: set BLENDER to its executable');
}

/**
 * Refuse a sheet the manifest calls grey whose red, green and blue differ
 * anywhere: the renderer reads its red channel as the grey.
 */
async function assertGrey(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels)
    if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) {
      const pixel = i / info.channels;
      throw new Error(
        `the sheet is not grey at (${pixel % info.width}, ${Math.floor(pixel / info.width)})`,
      );
    }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'view-sheet-'));
try {
  const bake = spawnSync(
    blender(),
    [
      '-b',
      '--factory-startup',
      '--python',
      path.join(root, 'scripts', 'bake-view-sheet.py'),
      '--',
      '--sheet',
      SHEET,
      '--out',
      scratch,
      ...(ONLY ? ['--only', ONLY] : []),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' },
  );
  for (const line of bake.stdout.split('\n'))
    if (/^(baked|wrote)\b/.test(line)) console.log(line);
  if (bake.status !== 0) {
    console.error(bake.stdout.split('\n').slice(-20).join('\n'));
    throw new Error(`the bake failed (exit ${bake.status})`);
  }
  const [json] = fs.readdirSync(scratch).filter((f) => f.endsWith('.json'));
  const name = path.basename(json, '.json');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(scratch, json), 'utf8'),
  );
  const png = path.join(scratch, `${name}.png`);
  if (manifest.grey) await assertGrey(png);
  fs.mkdirSync(OUT, { recursive: true });
  const webp = path.join(OUT, manifest.image);
  await sharp(png)
    .webp({ lossless: true, effort: 6, exact: true })
    .toFile(webp);
  fs.copyFileSync(path.join(scratch, json), path.join(OUT, json));
  const kb = Math.round(fs.statSync(webp).size / 1024);
  console.log(`wrote ${path.relative(root, webp)} (${kb} KB) and its manifest`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
