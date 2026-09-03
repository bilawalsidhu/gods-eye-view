#!/usr/bin/env node
// Render public/logo.svg into a macOS .icns (plus a 1024 px PNG preview).
//
//   node scripts/build-app-icon.mjs <out-dir>
//
// The logo is composited onto a rounded dark square so it reads as a Dock
// tile. Uses the repo's existing `sharp` devDependency for rasterizing and
// macOS `iconutil` for the .icns container.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(ROOT, 'dist-app', 'icon'));
const BG = '#0a0a0f';
const SIZE = 1024;

const { default: sharp } = await import('sharp');

const logoSvg = await fs.readFile(path.join(ROOT, 'public', 'logo.svg'), 'utf8');
// Strip the outer <svg> wrapper's xml/doctype noise but keep the element: it
// nests cleanly inside another <svg> as long as it carries a viewBox.
const inner = logoSvg.replace(/<\?xml[^>]*>/, '').trim();
const logoBox = 800;
const margin = (SIZE - logoBox) / 2;
const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="48%" r="55%">
      <stop offset="0%" stop-color="#0e2230"/>
      <stop offset="100%" stop-color="${BG}"/>
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="${SIZE * 0.2237}" fill="url(#glow)"/>
  <svg x="${margin}" y="${margin}" width="${logoBox}" height="${logoBox}" preserveAspectRatio="xMidYMid meet" viewBox="180 120 775 520">
    ${inner.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')}
  </svg>
</svg>`;

await fs.mkdir(outDir, { recursive: true });
const master = await sharp(Buffer.from(tile), { density: 300 }).png().toBuffer();
await fs.writeFile(path.join(outDir, 'AppIcon-1024.png'), master);

const iconset = path.join(outDir, 'AppIcon.iconset');
await fs.rm(iconset, { recursive: true, force: true });
await fs.mkdir(iconset, { recursive: true });
const entries = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
];
for (const [name, px] of entries) {
  await sharp(master).resize(px, px).png().toFile(path.join(iconset, name));
}

const icns = path.join(outDir, 'AppIcon.icns');
const result = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', icns], { stdio: 'inherit' });
if (result.status !== 0) {
  console.error('iconutil failed (macOS only). PNG iconset left in', iconset);
  process.exit(result.status ?? 1);
}
console.log('icon:', icns);
