import { ALPHA_EARTH_DEFAULT_THRESHOLD } from './constants.js';
import {
  chooseLevel,
  cogWindow,
  computeChange,
  outputGrid,
  sampleEmbeddings,
} from './grid.js';

/** Bounded fan-out for COG window reads (each read is 64 band-tile ranges). */
const READ_CONCURRENCY = 4;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Embedding change between two annual layers over a WGS84 box.
 *
 * Picks the finest overview whose reads fit `budgetBytes`, samples both years
 * onto one WGS84 grid, and returns the quantised `1 − cosine` grid with
 * summary statistics. Throws `{code:'no_coverage'}` when either year has no
 * COG over the box.
 *
 * @returns {Promise<object>} JSON-ready payload (grid as base64)
 */
export async function computeAlphaEarthChange({
  box,
  from,
  to,
  threshold = ALPHA_EARTH_DEFAULT_THRESHOLD,
  budgetBytes,
  catalog,
  reader,
  signal,
}) {
  const [fromCogs, toCogs] = await Promise.all([
    catalog.find(from, box),
    catalog.find(to, box),
  ]);
  if (!fromCogs.length || !toCogs.length) {
    throw Object.assign(new Error('no AlphaEarth coverage for this box'), {
      code: 'no_coverage',
    });
  }
  const { level, pixelMeters, estimatedBytes } = chooseLevel(
    box,
    [...fromCogs, ...toCogs],
    budgetBytes,
  );
  const grid = outputGrid(box, pixelMeters);

  const readYear = async (cogs) => {
    const plans = cogs
      .map((cog) => ({ cog, window: cogWindow(cog, box, level) }))
      .filter((plan) => plan.window);
    const reads = await mapLimit(plans, READ_CONCURRENCY, async (plan) => {
      signal?.throwIfAborted();
      return {
        ...plan,
        data: await reader.read(plan.cog, level, plan.window, { signal }),
      };
    });
    return sampleEmbeddings(grid, reads);
  };
  const a = await readYear(fromCogs);
  const b = await readYear(toCogs);
  const { grid: change, stats } = computeChange(a, b, threshold);

  return {
    from,
    to,
    west: box.west,
    south: box.south,
    east: box.east,
    north: box.north,
    width: grid.width,
    height: grid.height,
    level,
    pixelMeters,
    estimatedBytes: Math.round(estimatedBytes),
    threshold,
    stats,
    encoding: 'u8-change-254-nodata-255-north-up',
    grid: Buffer.from(
      change.buffer,
      change.byteOffset,
      change.byteLength,
    ).toString('base64'),
  };
}
