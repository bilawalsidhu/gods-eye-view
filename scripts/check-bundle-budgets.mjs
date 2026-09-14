#!/usr/bin/env node
/**
 * check-bundle-budgets.mjs — the bundle-budgets gate (docs/PLAN.md Phase 7,
 * issue #40). Run after `vite build` (CI's build job wires it directly after
 * the production build; locally: `npm run check:budgets`).
 *
 * Measures every built JS/CSS artifact plus the dist tree, classifies each
 * against the budget table in src/config/bundleBudgets.js, and cross-checks
 * the built sw.js precache manifest so the workbox per-file cap can never
 * SILENTLY drop the offline shell (the failure mode where the app keeps
 * working online and quietly loses precaching). Exits non-zero on any
 * violation; growth past a budget is a deliberate decision made in the
 * budget table, in the same commit that grows the bundle.
 *
 * Usage:
 *   node scripts/check-bundle-budgets.mjs [--dist dist] [--json out.json]
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DIST_TOTAL_BUDGET,
  PRECACHE_TOTAL_BUDGET,
  evaluateBundleBudgets,
} from '../src/config/bundleBudgets.js';

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const DIST_DIR = path.resolve(process.cwd(), argValue('--dist', 'dist'));
const JSON_OUT = argValue('--json', null);

const formatKiB = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

/** dist-relative artifacts the budget table classifies: built JS/CSS + the boot document. */
function collectBundledFiles(distDir) {
  const assetsDir = path.join(distDir, 'assets');
  if (!fs.existsSync(assetsDir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(js|css)$/.test(entry.name)) continue;
    const relative = path.posix.join('assets', entry.name);
    files.push({ path: relative, bytes: fs.statSync(path.join(assetsDir, entry.name)).size });
  }
  const indexHtml = path.join(distDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    files.push({ path: 'index.html', bytes: fs.statSync(indexHtml).size });
  }
  return files.sort((a, b) => b.bytes - a.bytes);
}

/** Total size of the whole dist/ tree, plus every dist-relative path in it. */
function measureDist(distDir) {
  let total = 0;
  const paths = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        total += fs.statSync(absolute).size;
        paths.push(path.relative(distDir, absolute).split(path.sep).join('/'));
      }
    }
  };
  visit(distDir);
  return { total, paths };
}

/**
 * URLs workbox actually precached, parsed out of the built sw.js
 * (`precacheAndRoute([{url:"index.html",...},...])` — minified, unquoted
 * keys, so a targeted url:"..." scan rather than JSON.parse).
 */
function readPrecacheManifest(distDir) {
  const swPath = path.join(distDir, 'sw.js');
  if (!fs.existsSync(swPath)) return null;
  const source = fs.readFileSync(swPath, 'utf8');
  return Array.from(source.matchAll(/url:"([^"]+)"/g), (match) => match[1]);
}

if (!fs.existsSync(DIST_DIR) || !fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  console.error(`BUNDLE-BUDGETS FAIL: no build output at ${DIST_DIR} — run \`npm run build\` first`);
  process.exit(1);
}

const files = collectBundledFiles(DIST_DIR);
if (!files.length) {
  console.error(`BUNDLE-BUDGETS FAIL: no assets under ${path.join(DIST_DIR, 'assets')} — was the build emitted?`);
  process.exit(1);
}
const { total: distTotal, paths: distPaths } = measureDist(DIST_DIR);
const precacheManifestUrls = readPrecacheManifest(DIST_DIR);
if (!precacheManifestUrls) {
  console.log('BUNDLE-BUDGETS WARN dist/sw.js absent — precache membership not verified');
}

const { classified, violations, precacheTotal } = evaluateBundleBudgets({
  files,
  distTotal,
  precacheManifestUrls,
  knownPaths: distPaths,
});

console.log(`BUNDLE-BUDGETS dist=${formatKiB(distTotal)} precache-shell=${formatKiB(precacheTotal)} (budget ${formatKiB(PRECACHE_TOTAL_BUDGET)}); dist ceiling ${formatKiB(DIST_TOTAL_BUDGET)}`);
for (const entry of classified) {
  const status = entry.ok ? 'OK  ' : 'FAIL';
  const scope = entry.precache ? ' precached' : '';
  console.log(`  ${status}  ${entry.path.padEnd(44)} ${formatKiB(entry.bytes).padStart(12)} / ${formatKiB(entry.budget).padEnd(12)} ${entry.label}${scope}`);
}
for (const violation of violations) {
  console.log(`  FAIL  ${violation.code}: ${violation.message}`);
}

if (JSON_OUT) {
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, `${JSON.stringify({ distTotal, precacheTotal, classified, violations }, null, 2)}\n`);
}

if (violations.length) {
  console.log(`BUNDLE-BUDGETS RESULT FAIL — ${violations.length} violation(s); budgets live in src/config/bundleBudgets.js`);
  process.exit(1);
}
console.log('BUNDLE-BUDGETS RESULT PASS');
