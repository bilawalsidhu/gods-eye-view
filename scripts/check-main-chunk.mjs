#!/usr/bin/env node
/**
 * The build gate for the Cesium-mode bundle: the main chunk (the module
 * script dist/index.html loads, or the Vite manifest's entry when the build
 * writes one) and every chunk it imports statically must carry no three or
 * Navara code; those load only through navaraMode.js's import(). Prints the
 * sizes (raw and gzip) and fails when a marker is found.
 *
 *   npm run build && node scripts/check-main-chunk.mjs [--dist=dist] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  entryFromHtml,
  entryFromManifest,
  forbiddenMarkersIn,
  initialChunks,
} from '../src/tooling/mainChunk.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
const dist = path.resolve(root, option('dist') ?? 'dist');
const asJson = process.argv.includes('--json');

function findEntry() {
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

const read = (file) => {
  const absolute = path.join(dist, file);
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
};

const { entry, via } = findEntry();
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
const main = chunks[0];
const failures = chunks.filter(
  (chunk) => chunk.missing || chunk.markers.length,
);
const result = {
  entry,
  via,
  mainBytes: main.bytes,
  mainGzipBytes: main.gzipBytes,
  initialBytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
  chunks,
  ok: failures.length === 0,
};

if (asJson) console.log(JSON.stringify(result, null, 2));
else {
  const kb = (bytes) => `${(bytes / 1000).toFixed(2)} kB`;
  console.log(`[main-chunk] entry ${entry} (via ${via})`);
  for (const chunk of chunks)
    console.log(
      `[main-chunk]   ${chunk.file}: ${kb(chunk.bytes)} (gzip ${kb(chunk.gzipBytes)})` +
        (chunk.missing ? ' MISSING' : '') +
        (chunk.markers.length ? ` FORBIDDEN: ${chunk.markers.join(', ')}` : ''),
    );
  console.log(
    `[main-chunk] main ${main.bytes} bytes (gzip ${main.gzipBytes}); initial chunks ${result.initialBytes} bytes`,
  );
  console.log(
    result.ok
      ? '[main-chunk] ok: no three or Navara in the main chunk'
      : '[main-chunk] FAIL',
  );
}
process.exitCode = result.ok ? 0 : 1;
