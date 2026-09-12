#!/usr/bin/env node
/**
 * streetview-headings.mjs
 *
 * Fetches Street View static images at 8 compass headings for a given lat/lon.
 * Uses the Street View Static API (not the Tiles API).
 *
 * Usage:
 *   node tools/streetview-headings.mjs --lat 30.268066 --lon -97.742813
 *   node tools/streetview-headings.mjs --lat 30.268066 --lon -97.742813 --fov 90 --pitch -10
 *   node tools/streetview-headings.mjs --lat 30.266476 --lon -97.73719 --neighbors
 *
 * Options:
 *   --lat        Latitude (required)
 *   --lon        Longitude (required)
 *   --fov        Field of view in degrees (default: 90, range: 10-120)
 *   --pitch      Camera pitch in degrees (default: 0, range: -90 to 90)
 *   --size       Image size WxH (default: 640x640)
 *   --outdir     Output directory (default: output/)
 *   --key        Google Maps API key (default: reads from .env)
 *   --neighbors  Also fetch 8 images from each first-order neighbor location
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { resolveGoogleServerKey } from '../scripts/google-server-key.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { fov: 90, pitch: 0, size: '640x640', outdir: 'output', neighbors: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--lat':        opts.lat = parseFloat(args[++i]); break;
      case '--lon':        opts.lon = parseFloat(args[++i]); break;
      case '--fov':        opts.fov = parseInt(args[++i], 10); break;
      case '--pitch':      opts.pitch = parseInt(args[++i], 10); break;
      case '--size':       opts.size = args[++i]; break;
      case '--outdir':     opts.outdir = args[++i]; break;
      case '--key':        opts.key = args[++i]; break;
      case '--step':       opts.step = parseInt(args[++i], 10); break;
      case '--neighbors':  opts.neighbors = true; break;
      case '--help':
        console.log('Usage: node tools/streetview-headings.mjs --lat <lat> --lon <lon> [--fov 90] [--pitch 0] [--size 640x640] [--neighbors]');
        process.exit(0);
    }
  }

  if (opts.lat === undefined || opts.lon === undefined) {
    console.error('Error: --lat and --lon are required.');
    process.exit(1);
  }

  return opts;
}

/** The explicit CLI key wins; otherwise prefer the server key across both stores. */
export function loadApiKey(overrideKey, {
  environment = process.env,
  envPath = join(PROJECT_ROOT, '.env'),
} = {}) {
  if (overrideKey) return overrideKey;
  const serverKey = resolveGoogleServerKey({
    GOOGLE_MAPS_SERVER_API_KEY: environment.GOOGLE_MAPS_SERVER_API_KEY,
  });
  if (serverKey) return serverKey;
  let fromDotenv = {};
  try {
    fromDotenv = parseEnv(readFileSync(envPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not read the Street View tool environment file');
  }
  const key = resolveGoogleServerKey(environment, fromDotenv);
  if (key) return key;
  throw new Error('No API key found. Set GOOGLE_MAPS_SERVER_API_KEY (or GOOGLE_MAPS_API_KEY) in .env or pass --key.');
}

// ---------------------------------------------------------------------------
// Fetch first-order neighbor locations via Google's internal metadata endpoint
// ---------------------------------------------------------------------------

async function getNeighborLocations(lat, lon) {
  const url = `https://maps.googleapis.com/maps/api/js/GeoPhotoService.SingleImageSearch?pb=!1m5!1sapiv3!5sUS!11m2!1m1!1b0!2m4!1m2!3d${lat}!4d${lon}!2d50!3m18!2m2!1sen!2sUS!9m1!1e2!11m12!1m3!1e2!2b1!3e2!1m3!1e3!2b1!3e2!1m3!1e10!2b1!3e2!4m6!1e1!1e2!1e3!1e4!1e8!1e6&callback=_`;
  const res = await fetch(url);
  if (!res.ok) return [];

  const text = await res.text();
  // Strip JSONP wrapper: "_ && _( ... )"
  const jsonStr = text.replace(/^[^(]*\(\s*/, '').replace(/\s*\)\s*;?\s*$/, '');
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    console.log('  Warning: could not parse neighbor metadata');
    return [];
  }

  // Navigate the nested response to extract linked panorama locations.
  // Structure: data[1][5][0][3][0] is array of linked panos.
  // Each link: link[2][0] = [null, null, lat, lng], link[3][2][0][0] = street name
  const neighbors = [];
  try {
    const links = data[1][5][0][3][0];
    // Origin coords from link[0]
    const originLat = links[0][2][0][2];
    const originLon = links[0][2][0][3];

    // Skip index 0 (that's the origin pano itself)
    for (let i = 1; i < links.length; i++) {
      const link = links[i];
      const coordBlock = link[2];
      if (!coordBlock || !coordBlock[0]) continue;
      const nlat = coordBlock[0][2];
      const nlon = coordBlock[0][3];
      if (nlat === undefined || nlon === undefined) continue;

      // Haversine distance — only keep first-order neighbors (within ~15m)
      const dlat = (nlat - originLat) * Math.PI / 180;
      const dlon = (nlon - originLon) * Math.PI / 180;
      const a = Math.sin(dlat / 2) ** 2
        + Math.cos(originLat * Math.PI / 180) * Math.cos(nlat * Math.PI / 180)
        * Math.sin(dlon / 2) ** 2;
      const dist = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      if (dist > 15) continue;

      // Extract street name if available
      let street = null;
      try { street = link[3][2][0][0]; } catch { /* no street name */ }
      neighbors.push({ lat: nlat, lon: nlon, street, dist });
    }
  } catch {
    console.log('  Warning: could not extract neighbor links from metadata');
  }

  return neighbors;
}

// ---------------------------------------------------------------------------
// Fetch 8 heading images for a single location
// ---------------------------------------------------------------------------

async function fetchHeadingsForLocation(lat, lon, label, directions, opts, apiKey, outdir) {
  console.log(`\n  [${label}] ${lat.toFixed(6)}, ${lon.toFixed(6)}`);

  for (const dir of directions) {
    const url = `https://maps.googleapis.com/maps/api/streetview?location=${lat},${lon}&heading=${dir.heading}&pitch=${opts.pitch}&fov=${opts.fov}&size=${opts.size}&source=outdoor&key=${apiKey}`;
    const res = await fetch(url, { headers: { 'Referer': 'http://localhost:4173/' } });

    if (!res.ok) {
      console.log(`    ${dir.name} (${dir.heading}): FAILED ${res.status}`);
      continue;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const outPath = join(outdir, `sv_${lat.toFixed(6)}_${lon.toFixed(6)}_${dir.heading.toString().padStart(3, '0')}_${dir.name}.jpg`);
    writeFileSync(outPath, buf);
    console.log(`    ${dir.name} (${dir.heading}): ${(buf.length / 1024).toFixed(1)} KB`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const apiKey = loadApiKey(opts.key);

  const outdir = resolve(PROJECT_ROOT, opts.outdir);
  mkdirSync(outdir, { recursive: true });

  // Generate headings at the specified step size (default 45°)
  const step = opts.step || 45;
  const directions = [];
  const compassNames = {
    0: 'N', 15: 'NNE', 30: 'NNE2', 45: 'NE', 60: 'ENE', 75: 'ENE2',
    90: 'E', 105: 'ESE', 120: 'ESE2', 135: 'SE', 150: 'SSE', 165: 'SSE2',
    180: 'S', 195: 'SSW', 210: 'SSW2', 225: 'SW', 240: 'WSW', 255: 'WSW2',
    270: 'W', 285: 'WNW', 300: 'WNW2', 315: 'NW', 330: 'NNW', 345: 'NNW2',
  };
  for (let h = 0; h < 360; h += step) {
    directions.push({ name: compassNames[h] || `H${h}`, heading: h });
  }

  console.log(`\nStreet View Headings`);
  console.log(`  Location: ${opts.lat}, ${opts.lon}`);
  console.log(`  FOV: ${opts.fov}, Pitch: ${opts.pitch}, Size: ${opts.size}`);
  console.log(`  Neighbors: ${opts.neighbors ? 'yes' : 'no'}`);

  // Fetch origin point
  await fetchHeadingsForLocation(opts.lat, opts.lon, 'origin', directions, opts, apiKey, outdir);

  // Fetch first-order neighbors
  if (opts.neighbors) {
    console.log(`\nFetching neighbor locations...`);
    const neighbors = await getNeighborLocations(opts.lat, opts.lon);

    if (neighbors.length === 0) {
      console.log('  No neighbors found.');
    } else {
      // Deduplicate: the static API snaps to nearest panorama, so nearby coords
      // resolve to the same imagery. Use the metadata API to get the actual pano_id
      // each coord resolves to, and skip duplicates.
      console.log(`  Raw neighbors: ${neighbors.length} (deduplicating via metadata...)`);
      const seenPanos = new Set();

      // Mark origin pano as seen
      const originMeta = await fetch(
        `https://maps.googleapis.com/maps/api/streetview/metadata?location=${opts.lat},${opts.lon}&source=outdoor&key=${apiKey}`,
        { headers: { 'Referer': 'http://localhost:4173/' } }
      );
      if (originMeta.ok) {
        const oj = await originMeta.json();
        if (oj.pano_id) seenPanos.add(oj.pano_id);
      }

      const uniqueNeighbors = [];
      for (const n of neighbors) {
        const metaRes = await fetch(
          `https://maps.googleapis.com/maps/api/streetview/metadata?location=${n.lat},${n.lon}&source=outdoor&key=${apiKey}`,
          { headers: { 'Referer': 'http://localhost:4173/' } }
        );
        if (!metaRes.ok) continue;
        const meta = await metaRes.json();
        if (!meta.pano_id || seenPanos.has(meta.pano_id)) continue;
        seenPanos.add(meta.pano_id);
        // Use the snapped location from metadata for more accurate coords
        uniqueNeighbors.push({
          lat: meta.location.lat,
          lon: meta.location.lng,
          street: n.street,
          dist: n.dist,
        });
      }

      console.log(`  Unique neighbors: ${uniqueNeighbors.length}`);
      for (const n of uniqueNeighbors) {
        const streetLabel = n.street ? ` (${n.street})` : '';
        console.log(`    ${n.lat.toFixed(6)}, ${n.lon.toFixed(6)}  ${n.dist.toFixed(1)}m${streetLabel}`);
      }

      for (let i = 0; i < uniqueNeighbors.length; i++) {
        const n = uniqueNeighbors[i];
        const label = n.street || `neighbor-${i + 1}`;
        await fetchHeadingsForLocation(n.lat, n.lon, label, directions, opts, apiKey, outdir);
      }
    }
  }

  console.log('\nDone.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('\nError:', err.message);
    process.exitCode = 1;
  });
}
