#!/usr/bin/env node
/**
 * Build the bundled river-discharge outlook point pack read by
 * `src/layers/riverDischarge/`:
 *
 *   src/data/local_data/river_discharge/points.json
 *
 * Maintainers run this; the app never does. It
 *
 *   1. samples points along named Natural Earth 10m river centrelines
 *      (public domain, pinned by commit and SHA-256);
 *   2. snaps each point to its river's GloFAS cell: the Open-Meteo Flood API
 *      reads the nearest 0.05° cell, which is often a dry cell or a minor
 *      tributary beside the main stem, so the 3×3 cell neighbourhood is read
 *      over a 140-day window and the cell with the largest mean flow wins;
 *   3. reads each snapped cell's daily GloFAS v4 reanalysis discharge over a
 *      ten-year window and stores p50 / p90 / p99, the mean and the record
 *      maximum.
 *
 * Open-Meteo's free API is non-commercial and limited to 600 / 5,000 /
 * 10,000 weighted calls per minute / hour / day. A location costs
 * max(1, days / 140) calls for one daily variable, so a point costs 9 (snap)
 * plus 26.1 (ten-year history). The script paces itself well under the
 * limits, keeps every response in `--cache` (outside the repository) so a
 * stopped run resumes without repeating calls, and refuses to start a stage
 * that would exceed `--max-weight`.
 *
 * Usage:
 *   node scripts/build-river-discharge-points.mjs [--cache <dir>]
 *     [--max-weight 8000] [--max-points 250] [--dry-run]
 *
 * The pack's `meta` records every parameter, the call weight spent and the
 * points dropped, and README.md beside the pack restates them.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dischargeClimatology,
  glofasNeighbourhood,
  openMeteoCallWeight,
  pickRiverCell,
  sampleRiverPoints,
} from '../src/layers/riverDischarge/climatology.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/data/local_data/river_discharge/points.json');
const NE_COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';

export const SOURCE = Object.freeze({
  url: `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_COMMIT}/geojson/ne_10m_rivers_lake_centerlines.geojson`,
  sha256: 'bb854a900ecbd3b408df46d5e16e3e0f974ba55993f9d8b5c26e855273c0905a',
});

const FLOOD_API = 'https://flood-api.open-meteo.com/v1/flood';

export const PARAMS = Object.freeze({
  sampling: {
    maxScalerank: 5,
    spacingKm: 800,
    minSeparationKm: 400,
  },
  snap: {
    radiusCells: 1,
    // 140 days of one daily variable is the most one weighted call buys.
    start: '2022-03-14',
    end: '2022-07-31',
    minMeanM3s: 10,
  },
  climatology: {
    // GloFAS v4 reanalysis in the seamless model ends July 2022; v4 values
    // are absent before mid-1997, so ten full years end on the last day.
    start: '2012-08-01',
    end: '2022-07-31',
    minCoverage: 0.9,
  },
  model: 'seamless_v4',
  pacing: {
    weightPerMinute: 300,
    weightPerHour: 3500,
    locationsPerSnapRequest: 27,
    locationsPerHistoryRequest: 4,
  },
});

const daysInclusive = (start, end) =>
  Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
      86_400_000,
  ) + 1;

function parseArgs(argv) {
  const args = {
    cache: path.join(os.tmpdir(), 'gev-river-discharge-cache'),
    maxWeight: 8000,
    maxPoints: 250,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--cache') args.cache = argv[++i];
    else if (flag === '--max-weight') args.maxWeight = Number(argv[++i]);
    else if (flag === '--max-points') args.maxPoints = Number(argv[++i]);
    else if (flag === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!(args.maxWeight > 0) || !(args.maxPoints > 0))
    throw new Error('--max-weight and --max-points must be positive');
  return args;
}

async function cachedSource(cacheDir) {
  const file = path.join(cacheDir, path.basename(SOURCE.url));
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    const response = await fetch(SOURCE.url, { redirect: 'error' });
    if (!response.ok)
      throw new Error(`Natural Earth download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(file, bytes);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== SOURCE.sha256)
    throw new Error(`Natural Earth SHA-256 mismatch: ${digest}`);
  return JSON.parse(bytes.toString('utf8'));
}

/** Weighted-call pacer: never more than the per-minute / per-hour budgets. */
function createPacer({ weightPerMinute, weightPerHour }) {
  const spent = [];
  const windowWeight = (since) =>
    spent.filter((s) => s.at > since).reduce((sum, s) => sum + s.weight, 0);
  return async function pace(weight) {
    for (;;) {
      const now = Date.now();
      if (
        windowWeight(now - 60_000) + weight <= weightPerMinute &&
        windowWeight(now - 3_600_000) + weight <= weightPerHour
      ) {
        spent.push({ at: now, weight });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function floodSeries(cells, { start, end }) {
  const params = new URLSearchParams({
    latitude: cells.map((c) => c.latitude.toFixed(3)).join(','),
    longitude: cells.map((c) => c.longitude.toFixed(3)).join(','),
    daily: 'river_discharge',
    start_date: start,
    end_date: end,
    models: PARAMS.model,
    timezone: 'GMT',
  });
  const response = await fetch(`${FLOOD_API}?${params}`, {
    redirect: 'error',
    headers: { 'User-Agent': 'gods-eye-view-river-discharge-build/1.0' },
  });
  if (response.status === 429)
    throw Object.assign(
      new Error('Open-Meteo rate limit reached; rerun later to resume'),
      { stop: true },
    );
  if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : [payload];
  if (rows.length !== cells.length)
    throw new Error('Open-Meteo returned a different location count');
  return rows.map((row) => {
    const values = row?.daily?.river_discharge;
    if (!Array.isArray(values))
      throw new Error('Open-Meteo row has no river_discharge');
    return values;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.cache, { recursive: true });
  const ne = await cachedSource(args.cache);
  const candidates = sampleRiverPoints(ne.features, {
    ...PARAMS.sampling,
    maxPoints: args.maxPoints,
  });
  const snapDays = daysInclusive(PARAMS.snap.start, PARAMS.snap.end);
  const historyDays = daysInclusive(
    PARAMS.climatology.start,
    PARAMS.climatology.end,
  );
  const neighbourhoodSize = (2 * PARAMS.snap.radiusCells + 1) ** 2;
  const snapWeightEach = openMeteoCallWeight({
    locations: neighbourhoodSize,
    days: snapDays,
  });
  const historyWeightEach = openMeteoCallWeight({
    locations: 1,
    days: historyDays,
  });

  const snapFile = path.join(args.cache, 'snap.json');
  const historyFile = path.join(args.cache, 'history.json');
  const snaps = await readJson(snapFile, {});
  const histories = await readJson(historyFile, {});
  const keyOf = (c) => `${c.position[1]},${c.position[0]}`;
  const pendingSnaps = candidates.filter((c) => !(keyOf(c) in snaps));
  const estimate =
    pendingSnaps.length * snapWeightEach +
    candidates.length * historyWeightEach;
  console.log(
    `${candidates.length} candidates; ${pendingSnaps.length} unsnapped; ` +
      `snap ${snapWeightEach}/pt, history ${historyWeightEach.toFixed(2)}/pt; ` +
      `upper-bound weight still to spend ${estimate.toFixed(0)} (cap ${args.maxWeight})`,
  );
  if (args.dryRun) return;

  const pace = createPacer(PARAMS.pacing);
  let spent = 0;
  const budget = (weight) => {
    if (spent + weight > args.maxWeight)
      throw Object.assign(
        new Error(`--max-weight ${args.maxWeight} reached; rerun to resume`),
        { stop: true },
      );
  };
  try {
    // Stage 2: snap.
    const perSnap = Math.max(
      1,
      Math.floor(PARAMS.pacing.locationsPerSnapRequest / neighbourhoodSize),
    );
    for (let i = 0; i < pendingSnaps.length; i += perSnap) {
      const batch = pendingSnaps.slice(i, i + perSnap);
      const cells = batch.flatMap((c) =>
        glofasNeighbourhood(
          c.position[1],
          c.position[0],
          PARAMS.snap.radiusCells,
        ),
      );
      const weight = openMeteoCallWeight({
        locations: cells.length,
        days: snapDays,
      });
      budget(weight);
      await pace(weight);
      const series = await floodSeries(cells, PARAMS.snap);
      spent += weight;
      batch.forEach((candidate, b) => {
        const group = cells
          .slice(b * neighbourhoodSize, (b + 1) * neighbourhoodSize)
          .map((cell, k) => ({
            ...cell,
            values: series[b * neighbourhoodSize + k],
          }));
        snaps[keyOf(candidate)] = pickRiverCell(group, {
          minMean: PARAMS.snap.minMeanM3s,
        });
      });
      await writeFile(snapFile, JSON.stringify(snaps));
      console.log(
        `snap ${Math.min(i + perSnap, pendingSnaps.length)}/${pendingSnaps.length} (spent ${spent.toFixed(1)})`,
      );
    }
    // Stage 3: ten-year history for each distinct snapped cell.
    const cellKey = (s) => `${s.latitude},${s.longitude}`;
    const cells = [];
    const seen = new Set();
    for (const c of candidates) {
      const s = snaps[keyOf(c)];
      if (!s || seen.has(cellKey(s))) continue;
      seen.add(cellKey(s));
      cells.push(s);
    }
    const pendingCells = cells.filter((s) => !(cellKey(s) in histories));
    for (
      let i = 0;
      i < pendingCells.length;
      i += PARAMS.pacing.locationsPerHistoryRequest
    ) {
      const batch = pendingCells.slice(
        i,
        i + PARAMS.pacing.locationsPerHistoryRequest,
      );
      const weight = openMeteoCallWeight({
        locations: batch.length,
        days: historyDays,
      });
      budget(weight);
      await pace(weight);
      const series = await floodSeries(batch, PARAMS.climatology);
      spent += weight;
      batch.forEach((cell, b) => {
        histories[cellKey(cell)] = dischargeClimatology(series[b], {
          minCoverage: PARAMS.climatology.minCoverage,
        });
      });
      await writeFile(historyFile, JSON.stringify(histories));
      console.log(
        `history ${Math.min(i + batch.length, pendingCells.length)}/${pendingCells.length} (spent ${spent.toFixed(1)})`,
      );
    }
  } catch (error) {
    if (!error.stop) throw error;
    console.log(`${error.message} (spent ${spent.toFixed(1)} this run)`);
    return;
  }

  // Stage 4: pack.
  const points = [];
  const dropped = { noRiverCell: 0, sharedCell: 0, thinHistory: 0 };
  const used = new Set();
  for (const c of candidates) {
    const s = snaps[keyOf(c)];
    if (!s) {
      dropped.noRiverCell++;
      continue;
    }
    const key = `${s.latitude},${s.longitude}`;
    if (used.has(key)) {
      dropped.sharedCell++;
      continue;
    }
    const climate = histories[key];
    if (!climate) {
      dropped.thinHistory++;
      continue;
    }
    used.add(key);
    points.push({
      id: `${s.latitude.toFixed(3)}_${s.longitude.toFixed(3)}`,
      name: c.name,
      lat: s.latitude,
      lon: s.longitude,
      p50: climate.p50,
      p90: climate.p90,
      p99: climate.p99,
      mean: climate.mean,
      max: climate.max,
    });
  }
  const pack = {
    meta: {
      title: 'River discharge outlook points',
      built: new Date().toISOString().slice(0, 10),
      schema:
        'points[]: id (GloFAS cell "lat_lon"), name (Natural Earth river), lat, lon (GloFAS v4 cell centre), p50/p90/p99/mean/max (m³/s, daily discharge over the climatology window)',
      sources: {
        rivers: { ...SOURCE, licence: 'Public domain (Natural Earth)' },
        discharge: {
          api: FLOOD_API,
          model: PARAMS.model,
          data: 'Copernicus Emergency Management Service GloFAS v4 reanalysis via Open-Meteo',
          licence: 'CC BY 4.0 (Open-Meteo); GloFAS data © Copernicus EMS',
        },
      },
      params: PARAMS,
      weightPerPoint: {
        snap: snapWeightEach,
        history: Number(historyWeightEach.toFixed(2)),
      },
      counts: { candidates: candidates.length, points: points.length, dropped },
    },
    points,
  };
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(pack)}\n`);
  console.log(
    `wrote ${points.length} points to ${path.relative(ROOT, OUT)}; dropped ${JSON.stringify(dropped)}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
