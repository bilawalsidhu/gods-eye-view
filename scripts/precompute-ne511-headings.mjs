/**
 * Precompute road-aligned headings for the Nebraska 511 camera pack.
 *
 * NDOT publishes no camera bearing, so the pack falls back to a deterministic
 * id-hash heading, which aims cones across the highway as often as along it.
 * This resolves each camera against OSM road geometry and writes a table the
 * catalog joins at load. Same shape as precompute-cctv-heights.mjs.
 *
 * Offline rather than at catalog load: `server/providers/cctv` may not import
 * the overpass package (check:boundaries), and one `around` query per camera
 * on every refresh is the API sweep the Overpass usage policy asks heavy
 * consumers to replace with a local extract.
 *
 * Usage:
 *   node scripts/precompute-ne511-headings.mjs [--limit N] [--force] [--out FILE]
 *
 * Resumable: cameras already recorded at the same position are kept and only
 * the missing ones are queried. --force re-queries everything.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNe511SourcesFromGraphQL } from '../server/providers/cctv/sources.js';
import {
  buildRoadQuery,
  nearestRoadAxis,
  resolveAxisDirection,
  positionKey,
} from '../server/providers/cctv/roadHeadings.js';
import { DEFAULT_NE511_HEADINGS_FILE } from '../server/providers/cctv/headings.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** Small unions keep each query inside the mirrors' time limits. */
const CHUNK = 8;
/** Pacing: this is someone else's free service. */
const DELAY_MS = 1500;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 8000;
/**
 * The main server answers 406 to a bare tool User-Agent, so requests send an
 * Accept header and a UA carrying a contact URL, as the usage policy asks.
 */
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];
const USER_AGENT =
  'gods-eye-view-ne511-heading-precompute/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse argv into the handful of flags this script accepts. */
export function parseArgs(argv) {
  const args = {
    limit: Infinity,
    force: false,
    out: DEFAULT_NE511_HEADINGS_FILE,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  if (!Number.isFinite(args.limit) && args.limit !== Infinity) {
    throw new Error('--limit expects a number');
  }
  return args;
}

/** Split an ordered array into bounded batches without mutating it. */
export function batches(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/**
 * POST one Overpass query, rotating mirrors and backing off on refusal.
 *
 * Returns null when every mirror and attempt failed, which is NOT an empty
 * element list: a failed chunk reported as [] would be recorded as "no road
 * nearby" and look resolved on the next run.
 *
 * @param {string} body - URL-encoded query body.
 * @returns {Promise<?Array<object>>} `elements`, or null if the query failed.
 */
async function fetchWays(body) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    for (const endpoint of MIRRORS) {
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body,
          signal: AbortSignal.timeout(90_000),
        });
        if (!resp.ok) continue;
        const parsed = JSON.parse(await resp.text());
        if (Array.isArray(parsed?.elements)) return parsed.elements;
      } catch {
        // Next mirror, then next attempt.
      }
    }
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS * attempt);
  }
  return null;
}

/** Read an existing table so an interrupted run can resume into it. */
async function readExisting(resolved) {
  try {
    const parsed = JSON.parse(await readFile(resolved, 'utf8'));
    return parsed?.cameras && typeof parsed.cameras === 'object'
      ? parsed.cameras
      : {};
  } catch {
    return {};
  }
}

/** Write atomically so a killed run leaves no half-written table. */
async function writeTable(resolved, cameras) {
  await mkdir(path.dirname(resolved), { recursive: true });
  const payload = {
    schemaVersion: 1,
    provider: 'openstreetmap-overpass',
    source: 'https://www.openstreetmap.org/copyright',
    license: 'ODbL 1.0',
    note: 'Road-axis headings derived from OSM way geometry. See scripts/precompute-ne511-headings.mjs.',
    generatedAt: new Date().toISOString(),
    cameras,
  };
  const tmp = `${resolved}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmp, resolved);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolved = path.isAbsolute(args.out)
    ? args.out
    : path.resolve(ROOT, args.out);

  const sources = (await loadNe511SourcesFromGraphQL()).slice(0, args.limit);
  if (!sources.length) {
    console.error('No Nebraska 511 sources returned; nothing to do.');
    process.exitCode = 1;
    return;
  }

  const cameras = args.force ? {} : await readExisting(resolved);
  // Keep an entry only while the camera still sits where it was sampled.
  const todo = sources.filter(
    (source) => cameras[source.id]?.positionKey !== positionKey(source),
  );
  console.log(
    `Nebraska 511: ${sources.length} cameras, ${sources.length - todo.length} already resolved, ${todo.length} to query.`,
  );
  if (!todo.length) {
    await writeTable(resolved, cameras);
    console.log(`Up to date: ${path.relative(ROOT, resolved)}`);
    return;
  }

  const chunks = batches(todo, CHUNK);
  let aligned = 0;
  let missed = 0;
  let failed = 0;
  for (const [index, chunk] of chunks.entries()) {
    const ways = await fetchWays(buildRoadQuery(chunk));
    if (ways === null) {
      // Record nothing: these stay in `todo` for a later run.
      failed += chunk.length;
      process.stdout.write(
        `\r  chunk ${index + 1}/${chunks.length}  QUERY FAILED (${failed} deferred)   `,
      );
      if (index < chunks.length - 1) await sleep(BACKOFF_MS);
      continue;
    }
    for (const source of chunk) {
      const axis = nearestRoadAxis(source, ways);
      if (axis === null) {
        cameras[source.id] = {
          positionKey: positionKey(source),
          status: 'no-road',
        };
        missed += 1;
        continue;
      }
      cameras[source.id] = {
        positionKey: positionKey(source),
        status: 'ok',
        axisDeg: Number(axis.toFixed(2)),
        headingDeg: Number(
          resolveAxisDirection(axis, source.name, source.headingDeg).toFixed(2),
        ),
      };
      aligned += 1;
    }
    // Checkpoint every chunk so an interrupted run keeps its work.
    await writeTable(resolved, cameras);
    process.stdout.write(
      `\r  chunk ${index + 1}/${chunks.length}  aligned ${aligned}  no-road ${missed}   `,
    );
    if (index < chunks.length - 1) await sleep(DELAY_MS);
  }
  process.stdout.write('\n');
  console.log(
    `Wrote ${path.relative(ROOT, resolved)}: ${aligned} aligned, ${missed} without a road in range.`,
  );
  if (failed) {
    console.warn(
      `${failed} camera(s) deferred by failed queries — re-run to pick them up.`,
    );
    process.exitCode = 2;
  }
}

// Only run when invoked directly, so the helpers stay unit-testable.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]).includes('precompute-ne511-headings')
) {
  await main();
}
