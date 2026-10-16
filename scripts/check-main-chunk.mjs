#!/usr/bin/env node
/**
 * The main-chunk gate of the Cesium-mode bundle (run after `npm run build`):
 *
 * 1. Composition: the main chunk (the Vite manifest's entry, or the module
 *    script dist/index.html loads) and every chunk it imports statically carry
 *    no three or Navara code (text markers; the build itself also fails on
 *    three/@navaramap module ids in initial chunks, build/initialChunkGuard.js).
 * 2. Budget, when scripts/main-chunk-baseline.json exists: gzip-9 of the
 *    largest dist/assets/index-*.js may exceed the recorded baseline by at
 *    most its allowance (the phase-4 branch's check; same exports,
 *    checkMainChunk and measureMainChunk, so the two merge into this script).
 *
 * Prints the sizes. `--json` prints the whole result; `--dist=DIR` reads
 * another build.
 *
 *   npm run build && npm run check:main-chunk
 */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  entryFromHtml,
  entryFromManifest,
  forbiddenMarkersIn,
  initialChunks,
} from '../src/tooling/mainChunk.js';

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
 * loads (`entry`, or found from dist/index.html or the Vite manifest), else
 * (phase 4's rule, for a dist without a page) the largest
 * dist/assets/index-*.js.
 */
export function measureMainChunk(distDir, { entry = null } = {}) {
  let file = entry;
  if (!file) {
    try {
      file = findEntry(distDir).entry;
    } catch {
      file = null;
    }
  }
  if (file) {
    const bytes = fs.readFileSync(path.join(distDir, file));
    return {
      name: path.basename(file),
      gzipBytes: gzipSync(bytes, { level: 9 }).length,
    };
  }
  const assets = path.join(distDir, 'assets');
  const candidates = fs
    .readdirSync(assets)
    .filter((name) => /^index-.*\.js$/.test(name))
    .map((name) => ({ name, bytes: fs.readFileSync(path.join(assets, name)) }))
    .sort((a, b) => b.bytes.length - a.bytes.length);
  if (!candidates.length)
    throw new Error('no dist/assets/index-*.js: run npm run build first');
  const [main] = candidates;
  return {
    name: main.name,
    gzipBytes: gzipSync(main.bytes, { level: 9 }).length,
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

/** Composition of the initial chunks: sizes and forbidden markers. */
export function checkComposition(dist) {
  const read = (file) => {
    const absolute = path.join(dist, file);
    return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
  };
  const { entry, via } = findEntry(dist);
  const chunks = initialChunks(entry, read).map((file) => {
    const code = read(file);
    if (code == null)
      return { file, missing: true, bytes: 0, gzipBytes: 0, markers: [] };
    return {
      file,
      bytes: Buffer.byteLength(code),
      gzipBytes: gzipSync(code).length,
      markers: forbiddenMarkersIn(code),
    };
  });
  return {
    entry,
    via,
    mainBytes: chunks[0].bytes,
    mainGzipBytes: chunks[0].gzipBytes,
    initialBytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
    chunks,
    ok: chunks.every((chunk) => !chunk.missing && !chunk.markers.length),
  };
}

function main() {
  const option = (name) =>
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
  const dist = path.resolve(ROOT, option('dist') ?? 'dist');
  const composition = checkComposition(dist);
  const baselinePath = path.join(ROOT, 'scripts/main-chunk-baseline.json');
  let budget = null;
  if (fs.existsSync(baselinePath)) {
    const measured = measureMainChunk(dist, { entry: composition.entry });
    budget = {
      ...measured,
      ...checkMainChunk(
        measured.gzipBytes,
        JSON.parse(fs.readFileSync(baselinePath, 'utf8')),
      ),
    };
  }
  const ok = composition.ok && (budget?.ok ?? true);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ composition, budget, ok }, null, 2));
  } else {
    const kb = (bytes) => `${(bytes / 1000).toFixed(2)} kB`;
    console.log(
      `[check:main-chunk] entry ${composition.entry} (via ${composition.via})`,
    );
    for (const chunk of composition.chunks)
      console.log(
        `[check:main-chunk]   ${chunk.file}: ${kb(chunk.bytes)} (gzip ${kb(chunk.gzipBytes)})` +
          (chunk.missing ? ' MISSING' : '') +
          (chunk.markers.length
            ? ` FORBIDDEN: ${chunk.markers.join(', ')}`
            : ''),
      );
    console.log(
      `[check:main-chunk] main ${composition.mainBytes} bytes (gzip ${composition.mainGzipBytes}); initial chunks ${composition.initialBytes} bytes; ` +
        (composition.ok
          ? 'no three or Navara'
          : 'three or Navara in the initial chunks'),
    );
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
