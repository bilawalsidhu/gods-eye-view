#!/usr/bin/env node
/**
 * Build src/data/local_data/gshhg_mask/land-sea-mask.bin — the bundled 1/8 deg
 * three-state global land/sea mask — from GSHHG native binary shorelines.
 *
 * Source:  GSHHG v2.3.7 (Global Self-consistent, Hierarchical, High-resolution
 *          Geography), intermediate resolution `gshhs_i.b` extracted from
 *          https://www.soest.hawaii.edu/pwessel/gshhg/gshhg-bin-2.3.7.zip
 *          (SOEST Hawaii). Not auto-downloaded: pass the extracted file's path
 *          and record its SHA-256 in src/data/local_data/gshhg_mask/README.md.
 * License: LGPL-3.0 — credited as "Wessel & Smith, GSHHG" (see DATA_SOURCES.md).
 *
 * Transform (deterministic):
 *   1. Parse the native .b stream (src/data/gshhg/parseGshhg.js): level 6
 *      (Antarctica grounding line) is skipped; level 5 (ice front) is land.
 *   2. Rasterize to 2880x1440 states (src/data/gshhg/rasterizeMask.js):
 *      even-odd scanline fill at cell-center latitudes, parity by level
 *      (L1/L3/L5 land, L2/L4 water), shoreline cells marked coastal.
 *   3. Sanity-assert the grid (Antarctica row 0 all land, ocean/land/lake spot
 *      checks, land fraction) through the same decode path the app uses.
 *   4. Pack 2 bits/cell behind the 16-byte GEVM header
 *      (src/data/landSeaMaskCodec.js): file is exactly 1,036,816 bytes.
 *
 * Usage:
 *   node scripts/build-land-sea-mask.mjs path/to/gshhs_i.b
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGshhg } from '../src/data/gshhg/parseGshhg.js';
import { rasterizeMask } from '../src/data/gshhg/rasterizeMask.js';
import {
  MASK_WIDTH, MASK_HEIGHT, MASK_WATER, MASK_LAND, MASK_COASTAL,
  buildMaskFileBuffer, decodeMaskBuffer, maskStateAt,
} from '../src/data/landSeaMaskCodec.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'data', 'local_data', 'gshhg_mask', 'land-sea-mask.bin');

const STATE_NAMES = ['water', 'land', 'coastal', 'reserved'];

/** Throws unless the decoded mask reads `expected` at (lat, lon). */
function assertStateAt(mask, lat, lon, expected, label) {
  const got = maskStateAt(mask, lat, lon);
  if (got !== expected) {
    throw new Error(`sanity check failed: ${label} (${lat}, ${lon}) ` +
      `expected ${STATE_NAMES[expected]}, got ${STATE_NAMES[got]}`);
  }
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: node scripts/build-land-sea-mask.mjs path/to/gshhs_i.b');
    process.exit(1);
  }
  const raw = fs.readFileSync(input);
  console.log(`read ${input}: ${(raw.byteLength / 1024 / 1024).toFixed(1)} MB`);
  const polygons = parseGshhg(raw);
  console.log(`parsed ${polygons.length} polygons (levels 1-5; level 6 skipped)`);

  const states = rasterizeMask(polygons, { width: MASK_WIDTH, height: MASK_HEIGHT });

  const counts = [0, 0, 0, 0];
  for (let i = 0; i < states.length; i += 1) counts[states[i]] += 1;
  // Land fraction = (land + coastal/2) / total over unweighted equal-angle
  // cells (coastal-mixed counted half). Outside 25-35% means a broken fill
  // (leaked cap, inverted parity), not plausible data drift.
  const landFraction = (counts[MASK_LAND] + counts[MASK_COASTAL] / 2) / states.length;

  // Row 0 (lat band [-90, -89.875)) is interior Antarctica: all land.
  for (let col = 0; col < MASK_WIDTH; col += 1) {
    if (states[col] !== MASK_LAND) {
      throw new Error(`sanity check failed: row 0 col ${col} is ` +
        `${STATE_NAMES[states[col]]}, expected land (polar-cap fill broke)`);
    }
  }

  const buffer = buildMaskFileBuffer(states, MASK_WIDTH, MASK_HEIGHT);
  // Spot checks go through decode + maskStateAt: the app's exact read path.
  const mask = decodeMaskBuffer(buffer);
  assertStateAt(mask, -85, 90, MASK_LAND, 'Antarctic interior');
  assertStateAt(mask, -60, -140, MASK_WATER, 'Southern Ocean');
  assertStateAt(mask, 39.7392, -104.9903, MASK_LAND, 'Denver');
  assertStateAt(mask, 0, -140, MASK_WATER, 'equatorial Pacific');
  assertStateAt(mask, 44, -87, MASK_WATER, 'Lake Michigan');
  if (landFraction < 0.25 || landFraction > 0.35) {
    throw new Error(`sanity check failed: land fraction ${landFraction.toFixed(4)} outside [0.25, 0.35]`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(buffer));
  console.log(`cells: ${counts[MASK_WATER]} water, ${counts[MASK_LAND]} land, ` +
    `${counts[MASK_COASTAL]} coastal`);
  console.log(`land fraction (land + coastal/2, unweighted cells): ${(landFraction * 100).toFixed(2)}%`);
  console.log(`wrote ${OUT}: ${buffer.byteLength} bytes`);
}

main().catch((err) => { console.error(err); process.exit(1); });
