#!/usr/bin/env node
/**
 * build-aircraft-views.mjs: bake the aircraft view sheet and ship it.
 *
 * Runs `scripts/build-aircraft-view-sheet.py` in Blender (headless) into a
 * scratch directory, then writes `public/sprites/aircraft-views.webp`
 * (lossless WebP of the baked PNG) and `src/data/aircraftViews.json` (its
 * manifest, which the app imports). With `--out`, the manifest is written
 * next to the WebP instead, unless `--manifest` names a path.
 * See `public/sprites/README.md`.
 *
 * Run:  npm run build:aircraft-views [-- --only airliner,light --out /tmp/views]
 *         [--manifest <path>]
 * Requires Blender 5.2 or newer for EXT_meshopt_compression in the fleet models.
 * Uses `$BLENDER`, else `blender` on the PATH, else the macOS app.
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
const SHIPPED = path.join(root, 'public', 'sprites');
const OUT = path.resolve(root, opt('--out', 'public/sprites'));
const MANIFEST = path.resolve(
  root,
  opt(
    '--manifest',
    OUT === SHIPPED
      ? 'src/data/aircraftViews.json'
      : path.join(OUT, 'aircraft-views.json'),
  ),
);
const ONLY = opt('--only', null);

const inside = (dir, file) => {
  const relative = path.relative(dir, file);
  return (
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
};
if (
  ONLY &&
  (inside(SHIPPED, OUT) ||
    MANIFEST === path.join(root, 'src', 'data', 'aircraftViews.json'))
) {
  console.error(
    '--only leaves other subjects empty. Give --out a directory outside public/sprites, and a --manifest other than src/data/aircraftViews.json.',
  );
  process.exit(1);
}

function blender() {
  if (process.env.BLENDER) return process.env.BLENDER;
  const which = spawnSync('which', ['blender'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const mac = '/Applications/Blender.app/Contents/MacOS/Blender';
  if (fs.existsSync(mac)) return mac;
  throw new Error('no Blender: set BLENDER to its executable');
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aircraft-views-'));
try {
  const bake = spawnSync(
    blender(),
    [
      '-b',
      '--factory-startup',
      '--python',
      path.join(root, 'scripts', 'build-aircraft-view-sheet.py'),
      '--',
      '--out',
      scratch,
      ...(ONLY ? ['--only', ONLY] : []),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' },
  );
  if (bake.error) throw bake.error;
  for (const line of bake.stdout.split('\n'))
    if (/^(baked|wrote)\b/.test(line)) console.log(line);
  if (bake.status !== 0) {
    console.error(bake.stdout.split('\n').slice(-20).join('\n'));
    throw new Error(`the bake failed (exit ${bake.status})`);
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(scratch, 'aircraft-views.json'), 'utf8'),
  );
  const png = path.join(scratch, 'aircraft-views.png');
  fs.mkdirSync(OUT, { recursive: true });
  const webp = path.join(OUT, manifest.image);
  await sharp(png)
    .webp({ lossless: true, effort: 6, exact: true })
    .toFile(webp);
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.copyFileSync(path.join(scratch, 'aircraft-views.json'), MANIFEST);
  const kb = Math.round(fs.statSync(webp).size / 1024);
  console.log(
    `wrote ${path.relative(root, webp)} (${kb} KB) and ${path.relative(root, MANIFEST)}`,
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
