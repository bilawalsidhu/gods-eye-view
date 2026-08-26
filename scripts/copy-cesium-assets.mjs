/**
 * copy-cesium-assets.mjs
 * Copies Cesium Workers, ThirdParty, Assets, and Widgets from node_modules to
 * public/cesium/ so they are included in the Vite build output at dist/cesium/.
 * This provides a local fallback when the CDN is unreachable.
 */
import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const cesiumSrc = join(root, 'node_modules', 'cesium', 'Build', 'Cesium');
const cesiumDst = join(root, 'public', 'cesium');

const DIRS = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];

function copyDir(src, dst) {
  if (!existsSync(src)) {
    console.warn(`[copy-cesium-assets] Source not found: ${src}`);
    return;
  }
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

for (const dir of DIRS) {
  copyDir(join(cesiumSrc, dir), join(cesiumDst, dir));
  console.log(`[copy-cesium-assets] Copied ${dir}/`);
}

console.log('[copy-cesium-assets] Done.');
