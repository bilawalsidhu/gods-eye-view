#!/usr/bin/env node
/**
 * The size budget of the Cesium-mode main chunk (run after `npm run build`):
 * gzip-9 of the entry chunk the built page loads (from the Vite manifest, or
 * the module script dist/index.html loads) may exceed the baseline in
 * scripts/main-chunk-baseline.json by at most its allowance. What the initial
 * chunks may hold is the build's own check (build/initialChunkGuard.js).
 *
 * Prints the size. `--json` prints the whole result; `--dist=DIR` reads
 * another build.
 *
 *   npm run build && npm run check:main-chunk
 */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { entryFromHtml, entryFromManifest } from '../src/tooling/mainChunk.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The verdict for a main-chunk size against the baseline. */
export function checkMainChunk(
  gzipBytes,
  { gzipBytes: baseline, allowanceBytes },
) {
  const limit = baseline + allowanceBytes;
  const growth = gzipBytes - baseline;
  return {
    ok: gzipBytes <= limit,
    message: `main chunk ${gzipBytes} bytes gzip-9 (${growth >= 0 ? '+' : ''}${growth} over the ${baseline} baseline; limit ${limit})`,
  };
}

/**
 * gzip-9 size of the main chunk, with its name: the entry the built page
 * loads (`entry`, else found from the Vite manifest or dist/index.html).
 */
export function measureMainChunk(distDir, { entry = null } = {}) {
  const file = entry ?? findEntry(distDir).entry;
  const bytes = fs.readFileSync(path.join(distDir, file));
  return {
    name: path.basename(file),
    gzipBytes: gzipSync(bytes, { level: 9 }).length,
  };
}

/** The entry chunk (relative to dist) and how it was found. */
function findEntry(dist) {
  const manifestPath = path.join(dist, '.vite', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const entry = entryFromManifest(
      JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
    );
    if (entry) return { entry, via: 'manifest' };
  }
  const htmlPath = path.join(dist, 'index.html');
  if (!fs.existsSync(htmlPath))
    throw new Error(`No build at ${dist}: run npm run build first`);
  const entry = entryFromHtml(fs.readFileSync(htmlPath, 'utf8'));
  if (!entry) throw new Error(`${htmlPath} loads no module script`);
  return { entry, via: 'index.html' };
}

function main() {
  const option = (name) =>
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
  const dist = path.resolve(ROOT, option('dist') ?? 'dist');
  const { entry, via } = findEntry(dist);
  const baselinePath = path.join(ROOT, 'scripts/main-chunk-baseline.json');
  let budget = null;
  if (fs.existsSync(baselinePath)) {
    const measured = measureMainChunk(dist, { entry });
    budget = {
      ...measured,
      ...checkMainChunk(
        measured.gzipBytes,
        JSON.parse(fs.readFileSync(baselinePath, 'utf8')),
      ),
    };
  }
  const ok = budget?.ok ?? true;
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ entry, via, budget, ok }, null, 2));
  } else {
    console.log(`[check:main-chunk] entry ${entry} (via ${via})`);
    console.log(
      budget
        ? `[check:main-chunk] ${budget.name}: ${budget.message}`
        : '[check:main-chunk] no scripts/main-chunk-baseline.json: size budget not checked',
    );
  }
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
