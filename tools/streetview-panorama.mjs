#!/usr/bin/env node
/**
 * streetview-panorama.mjs
 *
 * Fetches and stitches a full Street View panorama for any lat/lon
 * using the Google Map Tiles API (Street View Tiles endpoint).
 *
 * Usage:
 *   node tools/streetview-panorama.mjs --lat 30.268066 --lon -97.742813
 *   node tools/streetview-panorama.mjs --lat 30.268066 --lon -97.742813 --zoom 5
 *   node tools/streetview-panorama.mjs --lat 30.268066 --lon -97.742813 --radius 100
 *
 * Options:
 *   --lat       Latitude (required)
 *   --lon       Longitude (required)
 *   --zoom      Tile zoom level 0-5 (default: 3, full res = 5)
 *   --radius    Search radius in meters for nearest panorama (default: 50)
 *   --outdir    Output directory (default: output/)
 *   --key       Google Maps API key (default: reads GOOGLE_MAPS_API_KEY from .env or env)
 *
 * Requires: Map Tiles API enabled on the Google Cloud project.
 * Dependencies: sharp (npm install sharp)
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from '../scripts/project-root.mjs';
import sharp from 'sharp';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = projectRoot(import.meta.url);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { zoom: 3, radius: 50, outdir: 'output' };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--lat':    opts.lat = parseFloat(args[++i]); break;
      case '--lon':    opts.lon = parseFloat(args[++i]); break;
      case '--zoom':   opts.zoom = parseInt(args[++i], 10); break;
      case '--radius': opts.radius = parseInt(args[++i], 10); break;
      case '--outdir': opts.outdir = args[++i]; break;
      case '--key':    opts.key = args[++i]; break;
      case '--help':
        console.log(`Usage: node tools/streetview-panorama.mjs --lat <lat> --lon <lon> [--zoom 0-5] [--radius m] [--outdir dir] [--key apikey]`);
        process.exit(0);
    }
  }

  if (opts.lat === undefined || opts.lon === undefined) {
    console.error('Error: --lat and --lon are required.');
    process.exit(1);
  }

  if (opts.zoom < 0 || opts.zoom > 5) {
    console.error('Error: --zoom must be between 0 and 5.');
    process.exit(1);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Load API key from .env or environment
// ---------------------------------------------------------------------------

function loadApiKey(overrideKey) {
  if (overrideKey) return overrideKey;
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY;

  // Try to load from .env
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
// API helpers
// ---------------------------------------------------------------------------

const TILE_API = 'https://tile.googleapis.com/v1';
const COMMON_HEADERS = { 'Referer': 'http://localhost:4173/' };

async function createSession(apiKey) {
  const url = `${TILE_API}/createSession?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapType: 'streetview', language: 'en-US', region: 'US' }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createSession failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function findPanoId(apiKey, session, lat, lng, radius) {
  const url = `${TILE_API}/streetview/panoIds?session=${session}&key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations: [{ lat, lng }], radius }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`panoIds search failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  const panoId = data.panoIds?.[0];
  if (!panoId) {
    throw new Error(`No Street View panorama found within ${radius}m of ${lat}, ${lng}`);
  }
  return panoId;
}

async function getMetadata(apiKey, session, panoId) {
  const url = `${TILE_API}/streetview/metadata?session=${session}&key=${apiKey}&panoId=${panoId}`;
  const res = await fetch(url, { headers: COMMON_HEADERS });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`metadata failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function fetchTile(apiKey, session, panoId, z, x, y) {
  const url = `${TILE_API}/streetview/tiles/${z}/${x}/${y}?session=${session}&key=${apiKey}&panoId=${panoId}`;
  const res = await fetch(url, { headers: COMMON_HEADERS });
  if (!res.ok) {
    // Some edge tiles may be empty — return null
    if (res.status === 404 || res.status === 204) return null;
    const text = await res.text();
    throw new Error(`tile ${z}/${x}/${y} failed (${res.status}): ${text}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Panorama stitching
// ---------------------------------------------------------------------------

async function stitchPanorama(apiKey, session, panoId, metadata, zoom) {
  const { imageWidth, imageHeight, tileWidth, tileHeight } = metadata;

  // Street View tile grids follow a fixed power-of-2 scheme:
  //   zoom 0: 1×1    (360° FOV, entire panorama in one tile)
  //   zoom 1: 2×1
  //   zoom 2: 4×2
  //   zoom 3: 8×4
  //   zoom 4: 16×8
  //   zoom 5: 32×16  (11.25° FOV, but actual cols/rows may be fewer
  //                    since tiles past the image edge return 404)
  //
  // The grid dimensions are independent of imageWidth/imageHeight.
  // Lower-resolution panoramas (e.g. contributor panos) simply 404
  // at higher zoom levels where there aren't enough pixels.
  //
  // We use the fixed grid, then let fetchTile silently return null for
  // any tiles that 404 (edge padding). The stitched canvas size is
  // grid × tileSize, and real image content fills the upper-left portion.
  const tilesX = Math.pow(2, zoom);                       // cols: 1,2,4,8,16,32
  const tilesY = Math.max(1, Math.pow(2, zoom - 1));      // rows: 1,1,2,4, 8,16

  // The panorama image is an equirectangular projection: width = 360°,
  // height = 180°. The tile grid is always 2:1 aspect (except zoom 0
  // which is 1×1). The image content fills the grid, scaled to fit.
  const canvasWidth = tilesX * tileWidth;
  const canvasHeight = tilesY * tileHeight;

  // For the output, we use full canvas dimensions. The content fills
  // the grid (the server scales the panorama to fit). Any minor
  // padding at edges is harmless for equirectangular math.
  const panoWidth = canvasWidth;
  const panoHeight = canvasHeight;

  console.log(`Panorama at zoom ${zoom}: grid ${tilesX}x${tilesY} = ${tilesX * tilesY} tiles (${panoWidth}x${panoHeight}px)`);

  // Fetch all tiles with concurrency limit
  const CONCURRENCY = 6;
  const tiles = [];
  const queue = [];

  for (let y = 0; y < tilesY; y++) {
    for (let x = 0; x < tilesX; x++) {
      queue.push({ x, y });
    }
  }

  let completed = 0;
  const total = queue.length;

  async function worker() {
    while (queue.length > 0) {
      const { x, y } = queue.shift();
      const buf = await fetchTile(apiKey, session, panoId, zoom, x, y);
      tiles.push({ x, y, buf });
      completed++;
      if (completed % 10 === 0 || completed === total) {
        process.stdout.write(`  Fetched ${completed}/${total} tiles\r`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);
  console.log(`  Fetched ${total}/${total} tiles`);

  // Stitch with sharp
  console.log(`Stitching ${panoWidth}x${panoHeight} panorama...`);

  const composites = [];
  for (const { x, y, buf } of tiles) {
    if (!buf) continue;
    composites.push({
      input: buf,
      left: x * tileWidth,
      top: y * tileHeight,
    });
  }

  const panorama = sharp({
    create: {
      width: panoWidth,
      height: panoHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  }).composite(composites);

  const outBuf = await panorama.jpeg({ quality: 92 }).toBuffer();
  return { buffer: outBuf, width: panoWidth, height: panoHeight };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const apiKey = loadApiKey(opts.key);

  console.log(`\nStreet View Panorama Fetcher`);
  console.log(`  Location: ${opts.lat}, ${opts.lon}`);
  console.log(`  Zoom: ${opts.zoom} (0=tiny, 5=full res 13312x6656)`);
  console.log(`  Radius: ${opts.radius}m\n`);

  // Step 1: Create session
  console.log('Creating session...');
  const sessionData = await createSession(apiKey);
  const session = sessionData.session;
  console.log(`  Session created (tile size: ${sessionData.tileWidth}x${sessionData.tileHeight})\n`);

  // Step 2: Find nearest Google panorama (skip contributor panos)
  // Strategy: probe the requested point + N/S/E/W offsets, collect all
  // Google panos found (including their linked neighbors), pick closest.
  console.log(`Searching for Google panorama near ${opts.lat}, ${opts.lon}...`);
  const isGoogle = (m) => m.copyright?.includes('Google');
  const offsetM = 0.00027; // ~30m in degrees
  const distTo = (m) => {
    const dy = (m.lat - opts.lat) * 111320;
    const dx = (m.lng - opts.lon) * 111320 * Math.cos(opts.lat * Math.PI / 180);
    return Math.sqrt(dy * dy + dx * dx);
  };

  const probePoints = [
    { lat: opts.lat, lng: opts.lon },
    { lat: opts.lat + offsetM, lng: opts.lon },
    { lat: opts.lat - offsetM, lng: opts.lon },
    { lat: opts.lat, lng: opts.lon + offsetM },
    { lat: opts.lat, lng: opts.lon - offsetM },
    { lat: opts.lat + offsetM * 2, lng: opts.lon },
    { lat: opts.lat - offsetM * 2, lng: opts.lon },
    { lat: opts.lat, lng: opts.lon + offsetM * 2 },
    { lat: opts.lat, lng: opts.lon - offsetM * 2 },
  ];

  const seen = new Map(); // panoId → metadata
  const googlePanos = [];
  let fallback = null;

  for (const pt of probePoints) {
    let pId;
    try {
      pId = await findPanoId(apiKey, session, pt.lat, pt.lng, opts.radius);
    } catch { continue; }
    if (seen.has(pId)) continue;
    const candidate = await getMetadata(apiKey, session, pId);
    seen.set(pId, candidate);
    console.log(`  Probe ${pt.lat.toFixed(5)},${pt.lng.toFixed(5)} → ${pId.slice(0, 20)}… ${distTo(candidate).toFixed(0)}m (${candidate.copyright})`);
    if (isGoogle(candidate)) {
      googlePanos.push(candidate);
      // Also check immediate links for closer Google panos
      for (const link of (candidate.links || [])) {
        if (seen.has(link.panoId)) continue;
        const linked = await getMetadata(apiKey, session, link.panoId);
        seen.set(link.panoId, linked);
        if (isGoogle(linked)) {
          console.log(`    Link ${link.panoId.slice(0, 20)}… ${distTo(linked).toFixed(0)}m (${linked.copyright})`);
          googlePanos.push(linked);
        }
      }
      break; // found Google cluster, no need to probe further
    }
    if (!fallback) fallback = candidate;
  }

  // Pick the Google pano closest to the requested point
  let meta;
  if (googlePanos.length > 0) {
    googlePanos.sort((a, b) => distTo(a) - distTo(b));
    meta = googlePanos[0];
    console.log(`  Selected: ${meta.panoId.slice(0, 20)}… (${distTo(meta).toFixed(0)}m away)`);
  } else {
    meta = fallback;
    console.log(`  No Google pano found, using best available.`);
  }

  console.log(`\nMetadata:`);
  console.log(`  Panorama ID: ${meta.panoId}`);
  console.log(`  Location: ${meta.lat}, ${meta.lng}`);
  console.log(`  Image size: ${meta.imageWidth}x${meta.imageHeight}`);
  console.log(`  Heading: ${meta.heading} degrees`);
  console.log(`  Tilt: ${meta.tilt} degrees`);
  console.log(`  Date: ${meta.date || 'unknown'}`);
  console.log(`  Copyright: ${meta.copyright}`);
  if (meta.links?.length) {
    console.log(`  Links to ${meta.links.length} adjacent panorama(s):`);
    for (const link of meta.links) {
      console.log(`    - ${link.text || 'unnamed'} heading=${link.heading.toFixed(1)} panoId=${link.panoId}`);
    }
  }
  console.log();

  // Distance from requested location to actual panorama
  const dlat = (meta.lat - opts.lat) * 111320;
  const dlng = (meta.lng - opts.lon) * 111320 * Math.cos(opts.lat * Math.PI / 180);
  const distM = Math.sqrt(dlat * dlat + dlng * dlng);
  console.log(`  Distance from requested point: ${distM.toFixed(1)}m\n`);

  // Step 4: Fetch and stitch panorama
  const { buffer: panoBuffer, width: panoWidth, height: panoHeight } = await stitchPanorama(
    apiKey, session, meta.panoId, meta, opts.zoom
  );

  // Step 5: Save outputs
  const outdir = resolve(PROJECT_ROOT, opts.outdir);
  mkdirSync(outdir, { recursive: true });

  const panoPath = join(outdir, `panorama_${opts.lat}_${opts.lon}.jpg`);
  writeFileSync(panoPath, panoBuffer);

  console.log(`\nSaved: ${panoPath} (${(panoBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  Panorama: ${panoWidth}x${panoHeight}, heading=${meta.heading.toFixed(1)}, tilt=${meta.tilt.toFixed(1)}`);
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
