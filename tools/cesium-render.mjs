#!/usr/bin/env node
/**
 * cesium-render.mjs
 *
 * Renders a CesiumJS 3D view to a JPEG image using headless Chromium
 * (Puppeteer) with Google 3D Photorealistic tiles.
 *
 * Two modes:
 *
 *   Direct position (camera placed at lat/lon):
 *     node tools/cesium-render.mjs --lat 30.266476 --lon -97.73719 --heading 270 --pitch -15 --height 8
 *
 *   Look-at mode (camera computed to look at a target point):
 *     node tools/cesium-render.mjs --lookat-lat 30.266476 --lookat-lon -97.73719 --heading 270 --pitch -30 --height 20
 *
 * In look-at mode the camera is positioned behind the heading direction at
 * the distance needed so the target point is centered in view. The --height
 * is meters above ground at the *target* point, and --pitch must be negative
 * (looking down).
 *
 * Options:
 *   --lat        Camera latitude (direct mode)
 *   --lon        Camera longitude (direct mode)
 *   --lookat-lat Target latitude to look at (lookat mode)
 *   --lookat-lon Target longitude to look at (lookat mode)
 *   --heading    Compass heading in degrees, 0=N 90=E 180=S 270=W (default: 0)
 *   --pitch      Camera pitch in degrees, 0=horizon -90=down (default: -10)
 *   --height     Height above ground in meters (default: 8)
 *   --fov        Vertical field of view in degrees (default: 60)
 *   --width      Image width in pixels (default: 1280)
 *   --height-px  Image height in pixels (default: 720)
 *   --sse        Max screen-space error, lower = sharper (default: 2)
 *   --timeout    Max total wait in seconds (default: 30)
 *   --outdir     Output directory (default: output/)
 *   --key        Google Maps API key (default: reads from .env)
 *
 * Strategy:
 *   1. Overhead pass (500m up, looking down) to sample ground elevation.
 *   2. Position camera at target level (ground + --height meters).
 *   3. Progressive SSE refinement: step from SSE=16 down to target SSE,
 *      waiting for each LOD level to fully load before requesting more detail.
 *   4. 3-second settle pass for final texture uploads.
 *   5. Screenshot.
 *
 * Dependencies: puppeteer, cesium (for serving assets)
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from '../scripts/project-root.mjs';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = projectRoot(import.meta.url);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    heading: 0, pitch: -10, height: 8, fov: 60,
    width: 1280, heightPx: 720, sse: 2, timeout: 30, outdir: 'output',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--lat':        opts.lat = parseFloat(args[++i]); break;
      case '--lon':        opts.lon = parseFloat(args[++i]); break;
      case '--lookat-lat': opts.lookatLat = parseFloat(args[++i]); break;
      case '--lookat-lon': opts.lookatLon = parseFloat(args[++i]); break;
      case '--heading':    opts.heading = parseFloat(args[++i]); break;
      case '--pitch':      opts.pitch = parseFloat(args[++i]); break;
      case '--height':     opts.height = parseFloat(args[++i]); break;
      case '--fov':        opts.fov = parseFloat(args[++i]); break;
      case '--width':      opts.width = parseInt(args[++i], 10); break;
      case '--height-px':  opts.heightPx = parseInt(args[++i], 10); break;
      case '--sse':        opts.sse = parseFloat(args[++i]); break;
      case '--timeout':    opts.timeout = parseInt(args[++i], 10); break;
      case '--outdir':     opts.outdir = args[++i]; break;
      case '--key':        opts.key = args[++i]; break;
      case '--help':
        console.log([
          'Usage:',
          '  Direct:  node tools/cesium-render.mjs --lat <lat> --lon <lon> [options]',
          '  LookAt:  node tools/cesium-render.mjs --lookat-lat <lat> --lookat-lon <lon> [options]',
          '',
          'Position (pick one pair):',
          '  --lat        Camera latitude (direct mode)',
          '  --lon        Camera longitude (direct mode)',
          '  --lookat-lat Target latitude to look at (computes camera position)',
          '  --lookat-lon Target longitude to look at (computes camera position)',
          '',
          'Camera:',
          '  --heading    Compass heading (default: 0)',
          '  --pitch      Camera pitch (default: -10, must be <0 for lookat mode)',
          '  --height     Meters above ground (default: 8)',
          '  --fov        Vertical FOV degrees (default: 60)',
          '',
          'Output:',
          '  --width      Image width (default: 1280)',
          '  --height-px  Image height (default: 720)',
          '  --sse        Screen space error, lower=sharper (default: 2)',
          '  --timeout    Timeout seconds (default: 30)',
          '  --outdir     Output dir (default: output/)',
          '  --key        Google Maps API key',
        ].join('\n'));
        process.exit(0);
    }
  }

  // Validate: need either --lat/--lon or --lookat-lat/--lookat-lon, not both
  const hasDirect = opts.lat !== undefined && opts.lon !== undefined;
  const hasLookat = opts.lookatLat !== undefined && opts.lookatLon !== undefined;
  const hasPartialDirect = (opts.lat !== undefined) !== (opts.lon !== undefined);
  const hasPartialLookat = (opts.lookatLat !== undefined) !== (opts.lookatLon !== undefined);

  if (hasPartialDirect) {
    console.error('Error: --lat and --lon must both be provided.');
    process.exit(1);
  }
  if (hasPartialLookat) {
    console.error('Error: --lookat-lat and --lookat-lon must both be provided.');
    process.exit(1);
  }
  if (hasDirect && hasLookat) {
    console.error('Error: Use --lat/--lon OR --lookat-lat/--lookat-lon, not both.');
    process.exit(1);
  }
  if (!hasDirect && !hasLookat) {
    console.error('Error: Provide --lat/--lon (direct) or --lookat-lat/--lookat-lon (look-at).');
    process.exit(1);
  }

  if (hasLookat) {
    opts.mode = 'lookat';
    if (opts.pitch >= 0) {
      console.error('Error: --pitch must be negative in lookat mode (camera looks down at target).');
      process.exit(1);
    }
  } else {
    opts.mode = 'direct';
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
// Temporary HTTP server to serve Cesium assets + render page
// ---------------------------------------------------------------------------

function startServer() {
  const CESIUM_ROOT = join(PROJECT_ROOT, 'node_modules/cesium/Build/Cesium');
  const RENDER_HTML = join(__dirname, 'cesium-render.html');

  const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.glb': 'model/gltf-binary',
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let filePath;

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    } else if (url.pathname === '/' || url.pathname === '/index.html') {
      filePath = RENDER_HTML;
    } else if (url.pathname.startsWith('/cesium/')) {
      filePath = join(CESIUM_ROOT, url.pathname.slice('/cesium/'.length));
    } else {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    try {
      const data = readFileSync(filePath);
      const ext = filePath.slice(filePath.lastIndexOf('.'));
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const apiKey = loadApiKey(opts.key);

  console.log(`\nCesium 3D Renderer`);
  if (opts.mode === 'lookat') {
    console.log(`  Mode     : lookat`);
    console.log(`  Target   : ${opts.lookatLat}, ${opts.lookatLon}`);
  } else {
    console.log(`  Mode     : direct`);
    console.log(`  Camera   : ${opts.lat}, ${opts.lon}`);
  }
  console.log(`  Heading  : ${opts.heading}°  Pitch: ${opts.pitch}°  Height: ${opts.height}m`);
  console.log(`  FOV      : ${opts.fov}°  Size: ${opts.width}x${opts.heightPx}  SSE: ${opts.sse}`);
  console.log(`  Timeout  : ${opts.timeout}s\n`);

  // Step 1: Start temp HTTP server
  console.log('Starting asset server...');
  const { server, port } = await startServer();
  console.log(`  http://127.0.0.1:${port}\n`);

  let browser;
  try {
    // Step 2: Launch headless Chromium with ANGLE/SwiftShader
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
      ],
    });

    const page = await browser.newPage();

    // Load tiles directly at target resolution.
    // The HTML page does progressive SSE refinement (16→12→8→6→4→target)
    // to avoid overwhelming SwiftShader with tile requests all at once.
    const LOAD_W = opts.width, LOAD_H = opts.heightPx;
    await page.setViewport({ width: LOAD_W, height: LOAD_H });

    // Log browser console
    page.on('console', msg => {
      const type = msg.type();
      if (type === 'error' || type === 'warning' || type === 'log') {
        console.log(`  [${type}] ${msg.text()}`);
      }
    });

    // Step 3: Navigate to render page with params
    const urlParams = new URLSearchParams({
      heading: opts.heading,
      pitch: opts.pitch,
      height: opts.height,
      fov: opts.fov,
      sse: opts.sse,
      key: apiKey,
      mode: opts.mode,
    });
    if (opts.mode === 'lookat') {
      // Lookat mode: HTML page computes camera position from target + heading/pitch/height
      urlParams.set('targetLat', opts.lookatLat);
      urlParams.set('targetLon', opts.lookatLon);
    } else {
      // Direct mode: camera placed at lat/lon
      urlParams.set('lat', opts.lat);
      urlParams.set('lon', opts.lon);
    }
    const url = `http://127.0.0.1:${port}/?${urlParams}`;
    console.log(`Loading Cesium scene (${LOAD_W}x${LOAD_H})...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Step 4: Wait for tiles to load
    console.log('Waiting for tiles...');
    const timeoutMs = opts.timeout * 1000;
    try {
      await page.waitForFunction(
        'window.__tilesReady === true || window.__error !== null',
        { timeout: timeoutMs, polling: 500 }
      );
    } catch {
      console.log(`  Timed out after ${opts.timeout}s — capturing what we have.`);
    }

    // Check for errors
    const error = await page.evaluate('window.__error');
    if (error) throw new Error(`Cesium error: ${error}`);

    const ready = await page.evaluate('window.__tilesReady');
    if (ready) console.log('  Tiles loaded.');

    // Step 5: Screenshot
    const outdir = resolve(PROJECT_ROOT, opts.outdir);
    mkdirSync(outdir, { recursive: true });

    const fileLat = opts.mode === 'lookat' ? opts.lookatLat : opts.lat;
    const fileLon = opts.mode === 'lookat' ? opts.lookatLon : opts.lon;
    const prefix = opts.mode === 'lookat' ? 'cesium_lookat' : 'cesium';
    const outPath = join(outdir,
      `${prefix}_${fileLat}_${fileLon}_h${opts.heading}_p${opts.pitch}_${opts.height}m_${opts.width}x${opts.heightPx}.jpg`);

    await page.screenshot({
      path: outPath,
      type: 'jpeg',
      quality: 92,
      fullPage: false,
    });

    console.log(`\nSaved: ${outPath}`);

    // Report ground height and camera info
    const gh = await page.evaluate('window.__groundHeight');
    if (gh !== null) {
      console.log(`  Ground height: ${gh.toFixed(1)}m (WGS84 ellipsoid)`);
    }
    const cam = await page.evaluate('window.__cameraInfo');
    if (cam) {
      console.log(`  Camera pos   : ${cam.lat.toFixed(6)}, ${cam.lon.toFixed(6)}`);
      console.log(`  Camera alt   : ${cam.height.toFixed(1)}m (WGS84)`);
      console.log(`  True heading : ${cam.heading.toFixed(1)}°`);
      console.log(`  True pitch   : ${cam.pitch.toFixed(1)}°`);
      console.log(`  Distance     : ${cam.dist.toFixed(1)}m to target`);
    }

  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
