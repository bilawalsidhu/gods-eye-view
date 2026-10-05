#!/usr/bin/env node
/**
 * sat-ortho.mjs
 *
 * Fetches satellite tiles from the Google Map Tiles API and stitches them
 * into a single ortho image centered on a given lat/lon.
 *
 * Usage:
 *   node tools/sat-ortho.mjs --lat 30.266476 --lon -97.73719
 *   node tools/sat-ortho.mjs --lat 30.266476 --lon -97.73719 --zoom 21 --size 2048
 *   node tools/sat-ortho.mjs --lat 30.266476 --lon -97.73719 --zoom 22 --size 2048 --outdir output/
 *
 * Options:
 *   --lat      Center latitude (required)
 *   --lon      Center longitude (required)
 *   --zoom     Tile zoom level (default: 21, max typically 22)
 *   --size     Output image size in pixels, square (default: 2048)
 *   --outdir   Output directory (default: output/)
 *   --key      Google Maps API key (default: reads from .env)
 *
 * How it works:
 *   1. Creates a Map Tiles API session for satellite imagery.
 *   2. Computes which tiles cover a region centered on the target lat/lon,
 *      sized to produce at least --size x --size pixels of coverage.
 *   3. Downloads all tiles in parallel (with concurrency limit).
 *   4. Stitches tiles into a full grid image.
 *   5. Crops to --size x --size centered on the exact target pixel.
 *   6. Saves as JPEG.
 *
 * Dependencies: sharp (devDependency)
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from '../scripts/project-root.mjs';
import sharp from 'sharp';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = projectRoot(import.meta.url);
const TILE_SIZE = 256;
const MAX_CONCURRENT = 8;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { zoom: 21, size: 2048, outdir: 'output' };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--lat':    opts.lat = parseFloat(args[++i]); break;
      case '--lon':    opts.lon = parseFloat(args[++i]); break;
      case '--zoom':   opts.zoom = parseInt(args[++i], 10); break;
      case '--size':   opts.size = parseInt(args[++i], 10); break;
      case '--outdir': opts.outdir = args[++i]; break;
      case '--key':    opts.key = args[++i]; break;
      case '--help':
        console.log([
          'Usage: node tools/sat-ortho.mjs --lat <lat> --lon <lon> [options]',
          '',
          'Required:',
          '  --lat      Center latitude',
          '  --lon      Center longitude',
          '',
          'Options:',
          '  --zoom     Tile zoom level (default: 21)',
          '  --size     Output square size in pixels (default: 2048)',
          '  --outdir   Output directory (default: output/)',
          '  --key      Google Maps API key',
        ].join('\n'));
        process.exit(0);
    }
  }

  if (opts.lat === undefined || opts.lon === undefined) {
    console.error('Error: --lat and --lon are required.');
    process.exit(1);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Load API key
// ---------------------------------------------------------------------------

function loadApiKey(overrideKey) {
  if (overrideKey) return overrideKey;
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY;

  try {
    const envPath = join(PROJECT_ROOT, '.env');
    const envContent = readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eqIdx = trimmed.indexOf('=');
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key === 'GOOGLE_MAPS_API_KEY' && val) return val;
    }
  } catch { /* ignore */ }

  console.error('Error: No API key found. Set GOOGLE_MAPS_API_KEY in .env or pass --key.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Tile math
// ---------------------------------------------------------------------------

/** Convert lat/lon to fractional tile coordinates at a given zoom level. */
function latLonToTile(lat, lon, zoom) {
  const n = 2 ** zoom;
  const x = ((lon + 180) / 360) * n;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y };
}

/** Convert tile x/y (integer) + pixel offset back to lat/lon. */
function tilePxToLatLon(tileX, tileY, pxX, pxY, zoom) {
  const n = 2 ** zoom;
  const lon = ((tileX + pxX / TILE_SIZE) / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + pxY / TILE_SIZE) / n)));
  const lat = latRad * 180 / Math.PI;
  return { lat, lon };
}

/** Compute meters per pixel at a given latitude and zoom. */
function metersPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos(lat * Math.PI / 180)) / (2 ** zoom);
}

// ---------------------------------------------------------------------------
// Tile fetching
// ---------------------------------------------------------------------------

async function createSession(apiKey) {
  const res = await fetch(`https://tile.googleapis.com/v1/createSession?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Referer': 'http://localhost:4173/',
    },
    body: JSON.stringify({
      mapType: 'satellite',
      language: 'en-US',
      region: 'US',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create tile session: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.session;
}

async function fetchTile(zoom, x, y, session, apiKey) {
  const url = `https://tile.googleapis.com/v1/2dtiles/${zoom}/${x}/${y}?session=${session}&key=${apiKey}`;
  const res = await fetch(url, {
    headers: { 'Referer': 'http://localhost:4173/' },
  });

  if (!res.ok) {
    throw new Error(`Tile ${zoom}/${x}/${y} failed: ${res.status}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Fetch multiple tiles with a concurrency limit.
 * @param {Array<{zoom, x, y}>} tileCoords
 * @param {string} session
 * @param {string} apiKey
 * @returns {Map<string, Buffer>} key: "x,y" → JPEG buffer
 */
async function fetchTiles(tileCoords, session, apiKey) {
  const results = new Map();
  let idx = 0;
  let completed = 0;
  const total = tileCoords.length;

  async function worker() {
    while (idx < tileCoords.length) {
      const i = idx++;
      const { zoom, x, y } = tileCoords[i];
      try {
        const buf = await fetchTile(zoom, x, y, session, apiKey);
        results.set(`${x},${y}`, buf);
      } catch (err) {
        console.log(`    Warning: tile ${zoom}/${x}/${y} failed: ${err.message}`);
      }
      completed++;
      if (completed % 10 === 0 || completed === total) {
        process.stdout.write(`\r    ${completed}/${total} tiles fetched`);
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(MAX_CONCURRENT, total); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  console.log();

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const apiKey = loadApiKey(opts.key);

  const mpp = metersPerPixel(opts.lat, opts.zoom);
  const coverageM = mpp * opts.size;

  console.log('\nSatellite Ortho Stitcher');
  console.log(`  Center   : ${opts.lat}, ${opts.lon}`);
  console.log(`  Zoom     : ${opts.zoom}`);
  console.log(`  Output   : ${opts.size}x${opts.size} px`);
  console.log(`  GSD      : ~${(mpp * 100).toFixed(1)} cm/pixel`);
  console.log(`  Coverage : ~${coverageM.toFixed(0)}m x ${coverageM.toFixed(0)}m`);

  // Compute center tile position (fractional)
  const center = latLonToTile(opts.lat, opts.lon, opts.zoom);
  const centerTileX = Math.floor(center.x);
  const centerTileY = Math.floor(center.y);
  const centerPxX = (center.x - centerTileX) * TILE_SIZE;  // pixel offset within center tile
  const centerPxY = (center.y - centerTileY) * TILE_SIZE;

  // How many tiles we need on each side to cover --size/2 pixels from center
  const halfSize = opts.size / 2;
  const tilesLeft = Math.ceil((halfSize - centerPxX) / TILE_SIZE) + 1;
  const tilesRight = Math.ceil((halfSize - (TILE_SIZE - centerPxX)) / TILE_SIZE) + 1;
  const tilesUp = Math.ceil((halfSize - centerPxY) / TILE_SIZE) + 1;
  const tilesDown = Math.ceil((halfSize - (TILE_SIZE - centerPxY)) / TILE_SIZE) + 1;

  const minTileX = centerTileX - tilesLeft;
  const maxTileX = centerTileX + tilesRight;
  const minTileY = centerTileY - tilesUp;
  const maxTileY = centerTileY + tilesDown;

  const gridW = maxTileX - minTileX + 1;
  const gridH = maxTileY - minTileY + 1;
  const totalTiles = gridW * gridH;

  console.log(`  Grid     : ${gridW}x${gridH} = ${totalTiles} tiles`);
  console.log(`  Tile range: x=[${minTileX}, ${maxTileX}] y=[${minTileY}, ${maxTileY}]`);

  // Create session
  console.log('\nCreating tile session...');
  const session = await createSession(apiKey);

  // Build tile coordinate list
  const tileCoords = [];
  for (let ty = minTileY; ty <= maxTileY; ty++) {
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      tileCoords.push({ zoom: opts.zoom, x: tx, y: ty });
    }
  }

  // Fetch all tiles
  console.log(`  Fetching ${totalTiles} tiles (concurrency: ${MAX_CONCURRENT})...`);
  const t0 = performance.now();
  const tiles = await fetchTiles(tileCoords, session, apiKey);
  const fetchElapsed = ((performance.now() - t0) / 1000).toFixed(2);
  console.log(`    Fetched ${tiles.size}/${totalTiles} tiles in ${fetchElapsed}s`);

  if (tiles.size === 0) {
    console.error('Error: No tiles fetched.');
    process.exit(1);
  }

  // Stitch tiles into a full grid image
  console.log('\nStitching...');
  const stitchW = gridW * TILE_SIZE;
  const stitchH = gridH * TILE_SIZE;

  // Build composite input array for sharp
  const compositeInputs = [];
  for (let ty = minTileY; ty <= maxTileY; ty++) {
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      const key = `${tx},${ty}`;
      const buf = tiles.get(key);
      if (!buf) continue;
      const left = (tx - minTileX) * TILE_SIZE;
      const top = (ty - minTileY) * TILE_SIZE;
      compositeInputs.push({ input: buf, left, top });
    }
  }

  // Create blank canvas and composite all tiles
  let stitched = sharp({
    create: {
      width: stitchW,
      height: stitchH,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  }).jpeg();

  stitched = sharp(await stitched.composite(compositeInputs).toBuffer());

  // Crop to --size x --size centered on the target lat/lon
  const cropLeft = Math.round((centerTileX - minTileX) * TILE_SIZE + centerPxX - halfSize);
  const cropTop = Math.round((centerTileY - minTileY) * TILE_SIZE + centerPxY - halfSize);

  const cropped = await stitched
    .extract({
      left: Math.max(0, cropLeft),
      top: Math.max(0, cropTop),
      width: opts.size,
      height: opts.size,
    })
    .jpeg({ quality: 92 })
    .toBuffer();

  // Save
  const outdir = resolve(PROJECT_ROOT, opts.outdir);
  mkdirSync(outdir, { recursive: true });

  const outName = `sat_${opts.lat}_${opts.lon}_z${opts.zoom}_${opts.size}x${opts.size}.jpg`;
  const outPath = join(outdir, outName);
  await sharp(cropped).toFile(outPath);

  const totalElapsed = ((performance.now() - t0) / 1000).toFixed(2);
  console.log(`\nSaved: ${outPath}`);
  console.log(`  Size     : ${opts.size}x${opts.size}`);
  console.log(`  GSD      : ~${(mpp * 100).toFixed(1)} cm/pixel`);
  console.log(`  Coverage : ~${coverageM.toFixed(0)}m x ${coverageM.toFixed(0)}m`);
  console.log(`  Tiles    : ${tiles.size}`);
  console.log(`  Time     : ${totalElapsed}s`);

  // Report corner coordinates
  const topLeft = tilePxToLatLon(minTileX, minTileY, cropLeft - 0, cropTop - 0, opts.zoom);
  const botRight = tilePxToLatLon(minTileX, minTileY, cropLeft + opts.size, cropTop + opts.size, opts.zoom);
  console.log(`  NW corner: ${topLeft.lat.toFixed(6)}, ${topLeft.lon.toFixed(6)}`);
  console.log(`  SE corner: ${botRight.lat.toFixed(6)}, ${botRight.lon.toFixed(6)}`);
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
