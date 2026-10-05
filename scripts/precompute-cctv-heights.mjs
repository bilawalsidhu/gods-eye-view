import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  planeSupportPoints,
  poseHash,
  SUPPORT_KEYS,
} from '../src/data/cctvFootprint.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SAMPLE_KEYS = ['mount', ...SUPPORT_KEYS];
const BATCH_SIZES = [16, 4, 1];
const DEADLINE_MS = 90_000;

/** Extract the served nominal pose (the values the catalog ships). */
export function nominalPose(source) {
  const pose = Object.fromEntries(
    [
      'lat',
      'lon',
      'headingDeg',
      'pitchDeg',
      'fovDeg',
      'rangeM',
      'mountHeightM',
    ].map((key) => {
      if (typeof source[key] !== 'number' || !Number.isFinite(source[key])) {
        throw new Error(`Camera ${source.id}: invalid ${key}`);
      }
      return [key, source[key]];
    }),
  );
  if (Math.abs(pose.lat) > 90 || Math.abs(pose.lon) > 180) {
    throw new Error(`Camera ${source.id}: invalid coordinates`);
  }
  // Hashed exactly as served: the server join (groundHeights.js) and the
  // client (camera.servedPose) hash the same raw values, so no clamp here.
  return pose;
}

/** Return a roughly 2 km grid key, with longitude width fixed per row. */
export function cellKey({ lat, lon }) {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    throw new Error('Invalid cell coordinates');
  }
  const row = Math.min(8999, Math.floor((lat + 90) / 0.02));
  const rowLat = -90 + (row + 0.5) * 0.02;
  const lonWidth = 0.02 / Math.cos((rowLat * Math.PI) / 180);
  const col = Math.floor(((lon === 180 ? -180 : lon) + 180) / lonWidth);
  return `${row},${col}`;
}

/** Split an ordered array into bounded batches without mutating it. */
export function batches(items, size = 16) {
  if (!Number.isSafeInteger(size) || size < 1)
    throw new Error('Invalid batch size');
  const result = [];
  for (let i = 0; i < items.length; i += size)
    result.push(items.slice(i, i + size));
  return result;
}

/** Group cameras by cell and order cells numerically by row, then column. */
export function planCells(cameras) {
  const cells = new Map();
  for (const camera of cameras) {
    const key = cellKey(camera.pose);
    if (!cells.has(key)) cells.set(key, { key, cameras: [] });
    cells.get(key).cameras.push(camera);
  }
  return [...cells.values()].sort((a, b) => {
    const [ar, ac] = a.key.split(',').map(Number);
    const [br, bc] = b.key.split(',').map(Number);
    return ar - br || ac - bc;
  });
}

/** Preserve ellipsoidal metres; missing, non-finite and implausible values are null. */
export function plausibleHeight(height) {
  return Number.isFinite(height) && height >= -150 ? height : null;
}

/**
 * Only a complete, successful entry for exactly the current nominal pose is
 * reusable; an entry with missing supports is resampled (valid heights are
 * kept by mergeCameraSamples).
 */
export function needsSampling(entry, pose) {
  return (
    entry?.status !== 'ok' ||
    entry.poseHash !== poseHash(pose) ||
    (Array.isArray(entry.misses) && entry.misses.length > 0)
  );
}

/** Merge retry samples without losing valid heights; a missing mount stores no heights. */
export function mergeCameraSamples(
  pose,
  heights,
  previous,
  attempts,
  sampledAt,
) {
  const hash = poseHash(pose);
  const prior = previous?.poseHash === hash ? previous : null;
  const values = SAMPLE_KEYS.map(
    (key, i) =>
      plausibleHeight(heights[i]) ??
      plausibleHeight(
        key === 'mount' ? prior?.mountGroundM : prior?.supports?.[key],
      ),
  );
  const entry = {
    poseHash: hash,
    status: values[0] === null ? 'miss' : 'ok',
    misses: SAMPLE_KEYS.filter((_, i) => values[i] === null),
    sampledAt,
    attempts,
  };
  if (entry.status === 'ok') {
    entry.mountGroundM = values[0];
    entry.supports = Object.fromEntries(
      SUPPORT_KEYS.map((key, i) => [key, values[i + 1]]),
    );
  }
  return entry;
}

/** Build a sidecar while retaining entries outside this run's selection. */
export function mergeSidecar(existing, updates, generatedAt) {
  const cameras = { ...existing?.cameras, ...updates };
  return {
    schemaVersion: 1,
    provider: 'google-3d-tiles',
    heightReference: 'WGS84-ellipsoid',
    generatedAt,
    cameras: Object.fromEntries(
      Object.keys(cameras)
        .sort()
        .map((id) => [id, cameras[id]]),
    ),
  };
}

/** Parse pilot filters; the limit applies after kinds, before resume filtering. */
export function parseArgs(argv) {
  const options = { limit: Infinity, kinds: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--limit') {
      const value = argv[++i];
      if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
        throw new Error('--limit requires a non-negative integer');
      }
      options.limit = Number(value);
    } else if (arg === '--kinds') {
      const value = argv[++i];
      if (
        !value ||
        value.startsWith('--') ||
        value.split(',').some((kind) => !kind.trim())
      ) {
        throw new Error('--kinds requires comma-separated sourceKinds');
      }
      options.kinds = value.split(',').map((kind) => kind.trim());
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

/** Use the shared footprint's mount and nine supports in the sampling wire order. */
export function samplingPoints(pose) {
  const footprint = planeSupportPoints(pose);
  return SAMPLE_KEYS.map((key) => {
    const point = key === 'mount' ? footprint.mount : footprint.supports[key];
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon)) {
      throw new Error(
        `Shared planeSupportPoints returned invalid coordinates for ${key}`,
      );
    }
    return { lat: point.lat, lon: point.lon };
  });
}

/** Sample one cell serially, retrying failed cameras at most three times (16/4/1). */
export async function sampleCell(
  cameras,
  sampler,
  now = () => new Date().toISOString(),
  existing = null,
) {
  // Seed with the prior entries so a resumed camera keeps every valid height
  // it already has (mergeCameraSamples only replaces misses).
  const entries = Object.create(null);
  for (const camera of cameras) {
    if (existing?.[camera.id]) entries[camera.id] = existing[camera.id];
  }
  let pending = cameras;
  for (const [index, size] of BATCH_SIZES.entries()) {
    const retry = [];
    for (const batch of batches(pending, size)) {
      let samples;
      try {
        samples = await sampler.sample(batch);
      } catch (error) {
        sampler.warn?.(
          `Attempt ${index + 1}, ${batch.length} cameras: ${error.message}`,
        );
        // A timed-out evaluate can still be sampling: destroy its page before retrying.
        await sampler.recycle();
        samples = batch.map(() => []);
      }
      const sampledAt = now();
      for (let i = 0; i < batch.length; i += 1) {
        const camera = batch[i];
        const entry = mergeCameraSamples(
          camera.pose,
          samples[i] ?? [],
          entries[camera.id],
          index + 1,
          sampledAt,
        );
        entries[camera.id] = entry;
        if (entry.misses.length) retry.push(camera);
      }
    }
    pending = retry;
    if (!pending.length) break;
  }
  return entries;
}

/** Bound a sampling operation; callers must recycle its page after rejection. */
export async function withDeadline(operation, timeoutMs = DEADLINE_MS) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Height sampling timed out after ${timeoutMs / 1000} s`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function openPage(browser, base) {
  const page = await browser.newPage();
  try {
    await page.goto(
      `${base}/#v=2&lat=30&lon=-95&alt=17000000&heading=0&pitch=-90&roll=0`,
    );
    await page.waitForFunction(() => !!window.__godsEyeView?.viewer);
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function loadSidecar(output) {
  let existing;
  try {
    existing = JSON.parse(await readFile(output, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (
    existing?.schemaVersion !== 1 ||
    existing.provider !== 'google-3d-tiles' ||
    existing.heightReference !== 'WGS84-ellipsoid' ||
    !existing.cameras ||
    typeof existing.cameras !== 'object' ||
    Array.isArray(existing.cameras)
  ) {
    throw new Error(`Incompatible sidecar: ${output}`);
  }
  return existing;
}

async function writeSidecar(output, sidecar) {
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(sidecar, null, 2)}\n`);
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}

function counts(cameras, entries) {
  const ok = cameras.filter(
    (camera) => entries[camera.id]?.status === 'ok',
  ).length;
  return { ok, miss: cameras.length - ok };
}

async function main() {
  const started = Date.now();
  const options = parseArgs(process.argv.slice(2));
  const base = (process.env.GEV_BASE || 'http://localhost:4173').replace(
    /\/+$/,
    '',
  );
  const output = path.resolve(
    ROOT,
    process.env.OUT ||
      'src/data/local_data/cctv_ground_heights/cctv_ground_heights.json',
  );
  let sidecar = await loadSidecar(output);
  const response = await fetch(`${base}/api/cctv/sources`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
  const catalog = await response.json();
  if (!Array.isArray(catalog.sources))
    throw new Error('Catalog must contain sources[]');
  const ids = new Set();
  const selected = catalog.sources
    .filter(
      (source) => !options.kinds || options.kinds.includes(source.sourceKind),
    )
    .slice(0, options.limit)
    .flatMap((source) => {
      if (typeof source.id !== 'string' || !source.id || ids.has(source.id)) {
        throw new Error('Catalog has an invalid or duplicate camera id');
      }
      ids.add(source.id);
      let pose;
      try {
        pose = nominalPose(source);
      } catch (error) {
        // One camera with a malformed pose must not abort the whole run.
        console.warn(`skip ${source.id}: ${error.message}`);
        return [];
      }
      return [
        {
          id: source.id,
          sourceKind: source.sourceKind || 'unknown',
          pose,
        },
      ];
    });
  const pending = selected.filter((camera) =>
    needsSampling(sidecar?.cameras?.[camera.id], camera.pose),
  );
  const cells = planCells(pending);
  console.log(
    `${selected.length} cameras selected, ${selected.length - pending.length} resumed, ${pending.length} to sample in ${cells.length} cells`,
  );
  if (options.dryRun) {
    for (const cell of cells) {
      const sizes = batches(cell.cameras).map(
        (batch) => `${batch.length} cameras/${batch.length * 10} points`,
      );
      console.log(
        `cell ${cell.key}: ${cell.cameras.length} cameras; batches: ${sizes.join(', ')}`,
      );
    }
    console.log(
      'Retries: failed cameras in batches of 4, then singly; 3 attempts, 90 s per call.',
    );
    return;
  }

  // Validate shared geometry before starting an expensive browser session.
  for (const camera of pending) camera.points = samplingPoints(camera.pose);
  let browser;
  try {
    if (pending.length) {
      const { default: puppeteer } = await import('puppeteer');
      browser = await puppeteer.launch({
        headless: false,
        executablePath:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        protocolTimeout: 600000,
        args: [
          '--no-sandbox',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--window-size=1200,800',
        ],
      });
      let page = await openPage(browser, base);
      const sampler = {
        warn: (message) => console.error(message),
        recycle: async () => {
          await page.close();
          page = await openPage(browser, base);
        },
        sample: (batch) =>
          withDeadline(
            page.evaluate(async (cameras) => {
              const gev = window.__godsEyeView;
              const scene = gev.viewer.scene;
              const Cartesian3 = gev.viewer.camera.position.constructor;
              const Cartographic =
                gev.viewer.camera.positionCartographic.constructor;
              const lat =
                cameras.reduce((sum, camera) => sum + camera.pose.lat, 0) /
                cameras.length;
              const lon =
                cameras.reduce((sum, camera) => sum + camera.pose.lon, 0) /
                cameras.length;
              gev.viewer.camera.setView({
                destination: Cartesian3.fromDegrees(lon, lat, 3000),
                orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
              });
              const cartographics = cameras.flatMap((camera) =>
                camera.points.map((point) =>
                  Cartographic.fromDegrees(point.lon, point.lat),
                ),
              );
              const sampled =
                await scene.sampleHeightMostDetailed(cartographics);
              return cameras.map((_, i) =>
                sampled
                  .slice(i * 10, (i + 1) * 10)
                  .map((point) =>
                    Number.isFinite(point.height) ? point.height : null,
                  ),
              );
            }, batch),
          ),
      };
      for (const cell of cells) {
        const cellStarted = Date.now();
        const entries = await sampleCell(
          cell.cameras,
          sampler,
          undefined,
          sidecar?.cameras,
        );
        sidecar = mergeSidecar(sidecar, entries, new Date().toISOString());
        await writeSidecar(output, sidecar);
        const tally = counts(cell.cameras, entries);
        console.log(
          `cell ${cell.key}: ${cell.cameras.length} cameras, ${tally.ok} ok/${tally.miss} miss, ${((Date.now() - cellStarted) / 1000).toFixed(1)} s`,
        );
      }
    }
  } finally {
    if (browser) await browser.close();
  }
  const entries = sidecar?.cameras || {};
  const tally = counts(selected, entries);
  console.log(
    `Total: ${selected.length} cameras, ${tally.ok} ok/${tally.miss} miss, ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
  for (const kind of [
    ...new Set(selected.map((camera) => camera.sourceKind)),
  ].sort()) {
    const tally = counts(
      selected.filter((camera) => camera.sourceKind === kind),
      entries,
    );
    console.log(`  ${kind}: ${tally.ok} ok/${tally.miss} miss`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
