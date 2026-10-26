#!/usr/bin/env node
/**
 * Generate Android adaptive and legacy launcher icons from `public/logo.svg`.
 *
 * Run: `node scripts/mobile/generate-icons.mjs`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const LOGO = path.join(REPO_ROOT, 'public', 'logo.svg');
const RES_ROOT = path.join(REPO_ROOT, 'android', 'app', 'src', 'main', 'res');

/** `--bg-dark` from `src/ui/styles/foundation.css` — matches web icons & app theme. */
const BACKGROUND = '#0a0a0f';
const BG_RGBA = { r: 10, g: 10, b: 15, alpha: 1 };
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/**
 * Android launcher icon densities:
 * - Adaptive foreground: 108dp canvas, 72dp safe zone (66.6%).
 * - Legacy square/round: 48dp canvas, 38dp mark (~80%).
 */
const DENSITIES = [
  {
    folder: 'mipmap-mdpi',
    fgSize: 108,
    fgSafe: 72,
    legacySize: 48,
    legacySafe: 38,
  },
  {
    folder: 'mipmap-hdpi',
    fgSize: 162,
    fgSafe: 108,
    legacySize: 72,
    legacySafe: 58,
  },
  {
    folder: 'mipmap-xhdpi',
    fgSize: 216,
    fgSafe: 144,
    legacySize: 96,
    legacySafe: 76,
  },
  {
    folder: 'mipmap-xxhdpi',
    fgSize: 324,
    fgSafe: 216,
    legacySize: 144,
    legacySafe: 116,
  },
  {
    folder: 'mipmap-xxxhdpi',
    fgSize: 432,
    fgSafe: 288,
    legacySize: 192,
    legacySafe: 154,
  },
];

/**
 * Render `svg` centered inside a `size`x`size` canvas with the given background.
 * @param {Buffer} svg Raw SVG bytes.
 * @param {{ size: number, safe: number, background: { r: number, g: number, b: number, alpha: number } }} spec Target dimensions.
 * @returns {Promise<Buffer>} PNG bytes.
 */
async function renderCentered(svg, { size, safe, background }) {
  const mark = await sharp(svg, { density: 384 })
    .resize(safe, safe, { fit: 'contain', background: TRANSPARENT })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background,
    },
  })
    .composite([{ input: mark, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function backgroundVectorXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
  <path
      android:fillColor="${BACKGROUND}"
      android:pathData="M0,0h108v108h-108z" />
</vector>
`;
}

function backgroundColorXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${BACKGROUND}</color>
</resources>
`;
}

async function main() {
  const svg = await readFile(LOGO);

  for (const d of DENSITIES) {
    const outDir = path.join(RES_ROOT, d.folder);
    await mkdir(outDir, { recursive: true });
    const fgPng = await renderCentered(svg, {
      size: d.fgSize,
      safe: d.fgSafe,
      background: TRANSPARENT,
    });
    const legacyPng = await renderCentered(svg, {
      size: d.legacySize,
      safe: d.legacySafe,
      background: BG_RGBA,
    });
    await writeFile(path.join(outDir, 'ic_launcher_foreground.png'), fgPng);
    await writeFile(path.join(outDir, 'ic_launcher.png'), legacyPng);
    await writeFile(path.join(outDir, 'ic_launcher_round.png'), legacyPng);
  }

  await writeFile(
    path.join(RES_ROOT, 'drawable', 'ic_launcher_background.xml'),
    backgroundVectorXml(),
  );
  await writeFile(
    path.join(RES_ROOT, 'values', 'ic_launcher_background.xml'),
    backgroundColorXml(),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
