import {
  intersects,
  countView,
  validateCountOverview,
  validateCountChunk,
} from './countGrids.js';
import { readTiles } from './tileReads.js';

export const COUNT_FETCH_LIMITS = Object.freeze({
  bytes: 8 * 1024 * 1024,
  cells: 65536,
  requests: 64,
  entries: 96,
});
const reference = (ref) => {
  if (
    !ref ||
    !/^[a-f0-9]{64}\.counts\.json$/.test(ref.url) ||
    ref.url !== `${ref.sha256}.counts.json` ||
    !Number.isSafeInteger(ref.bytes) ||
    ref.bytes < 1 ||
    ref.bytes > COUNT_FETCH_LIMITS.bytes
  )
    throw new TypeError('Invalid partitioned count reference');
};

function validateSubtree(level, previous, bounds) {
  const parents = previous.cells.filter(
    (c) =>
      c.bounds[0] >= bounds[0] &&
      c.bounds[1] >= bounds[1] &&
      c.bounds[2] <= bounds[2] &&
      c.bounds[3] <= bounds[3],
  );
  const sums = new Map();
  for (const cell of level.cells) {
    const x = Math.floor((cell.bounds[0] + 180) / previous.degrees),
      y = Math.floor((cell.bounds[1] + 90) / previous.degrees),
      key = `${x}:${y}`;
    const sum = sums.get(key) ?? { count: 0, x: 0, y: 0 };
    sum.count += cell.count;
    sum.x += cell.center[0] * cell.count;
    sum.y += cell.center[1] * cell.count;
    sums.set(key, sum);
  }
  if (sums.size !== parents.length)
    throw new TypeError('Count chunk hierarchy mismatch');
  for (const parent of parents) {
    const sum = sums.get(
      `${Math.round((parent.bounds[0] + 180) / previous.degrees)}:${Math.round((parent.bounds[1] + 90) / previous.degrees)}`,
    );
    if (
      !sum ||
      sum.count !== parent.count ||
      Math.abs(sum.x - parent.center[0] * parent.count) > 1e-7 * parent.count ||
      Math.abs(sum.y - parent.center[1] * parent.count) > 1e-7 * parent.count
    )
      throw new TypeError('Count chunk hierarchy mismatch');
  }
}

/** Hash-keyed, byte/cell/entry-bounded immutable cache; no request or renderer ownership. */
export function createPartitionedCountLoader() {
  const cache = new Map();
  let bytes = 0,
    cells = 0;
  async function obtain(ref, read, validate) {
    const cached = cache.get(ref.sha256);
    if (cached) {
      if (cached.bytes !== ref.bytes)
        throw new TypeError('Count reference byte mismatch');
      validate(cached.value);
      cache.delete(ref.sha256);
      cache.set(ref.sha256, cached);
      return cached.value;
    }
    const value = await read(ref);
    validate(value);
    const count = value.levels.reduce((n, level) => n + level.cells.length, 0);
    if (count <= COUNT_FETCH_LIMITS.cells) {
      if (cache.has(ref.sha256)) {
        const previous = cache.get(ref.sha256);
        bytes -= previous.bytes;
        cells -= previous.cells;
        cache.delete(ref.sha256);
      }
      while (
        cache.size &&
        (bytes + ref.bytes > COUNT_FETCH_LIMITS.bytes ||
          cells + count > COUNT_FETCH_LIMITS.cells ||
          cache.size >= COUNT_FETCH_LIMITS.entries)
      ) {
        const key = cache.keys().next().value,
          old = cache.get(key);
        bytes -= old.bytes;
        cells -= old.cells;
        cache.delete(key);
      }
      cache.set(ref.sha256, { value, bytes: ref.bytes, cells: count });
      bytes += ref.bytes;
      cells += count;
    }
    return value;
  }
  return {
    getCacheStats: () => ({ bytes, cells, entries: cache.size }),
    async load(ref, total, bounds, budget, read) {
      if (
        ref?.schemaVersion !== 2 ||
        ref.kind !== 'gev-well-partitioned-counts' ||
        ref.total !== total ||
        !Array.isArray(ref.levels) ||
        ref.levels.length !== 2
      )
        throw new TypeError('Invalid partitioned count manifest');
      reference(ref.overview);
      const overview = await obtain(ref.overview, read, (v) =>
        validateCountOverview(v, total),
      );
      const parents = new Map(
        overview.levels[2].cells.map((c) => [JSON.stringify(c.bounds), c]),
      );
      const urls = new Set([ref.overview.url]);
      for (const [i, level] of ref.levels.entries()) {
        if (
          level.degrees !== [0.125, 0.03125][i] ||
          !Array.isArray(level.chunks) ||
          level.chunks.length !== parents.size ||
          !Number.isSafeInteger(level.cellCount)
        )
          throw new TypeError('Invalid partitioned count level');
        const seen = new Set();
        let population = 0,
          occupied = 0;
        for (const chunk of level.chunks) {
          reference(chunk);
          const key = JSON.stringify(chunk.bounds),
            parent = parents.get(key);
          if (
            !parent ||
            seen.has(key) ||
            urls.has(chunk.url) ||
            chunk.count !== parent.count ||
            !Number.isSafeInteger(chunk.cellCount) ||
            chunk.cellCount < 1 ||
            chunk.cellCount > (2 / level.degrees) ** 2
          )
            throw new TypeError('Count chunk accounting mismatch');
          seen.add(key);
          urls.add(chunk.url);
          population += chunk.count;
          occupied += chunk.cellCount;
        }
        if (population !== total || occupied !== level.cellCount)
          throw new TypeError('Partitioned count conservation');
      }
      const levels = [...overview.levels];
      let requestedBytes = 0,
        requestedCells = 0,
        requested = 0,
        capped = false;
      for (const level of ref.levels) {
        const matching = level.chunks.filter(
          (c) => bounds && intersects(c.bounds, bounds),
        );
        const levelBytes = matching.reduce((n, c) => n + c.bytes, 0),
          levelCells = matching.reduce((n, c) => n + c.cellCount, 0);
        if (
          requested + matching.length > COUNT_FETCH_LIMITS.requests ||
          requestedBytes + levelBytes > COUNT_FETCH_LIMITS.bytes ||
          requestedCells + levelCells > COUNT_FETCH_LIMITS.cells
        ) {
          capped = true;
          break;
        }
        requested += matching.length;
        requestedBytes += levelBytes;
        requestedCells += levelCells;
        const chunks = await readTiles(matching, (chunk) =>
          obtain(chunk, read, (v) => {
            const parsed = validateCountChunk(
              v,
              parents.get(JSON.stringify(chunk.bounds)),
              level.degrees,
            );
            validateSubtree(parsed, levels.at(-1), chunk.bounds);
            if (parsed.cells.length !== chunk.cellCount)
              throw new TypeError('Count chunk cell count mismatch');
          }),
        );
        const combined = {
          degrees: level.degrees,
          total,
          cells: chunks.flatMap((v) => v.levels[0].cells),
        };
        levels.push(combined);
        // Match the existing first-over-budget stopping rule; do not fetch a
        // finer level the renderer cannot yet admit.
        if (
          countView({ ...overview, levels }, bounds, '', budget).degrees !==
          level.degrees
        )
          break;
      }
      // Views own their cells; a caller cannot mutate cached source evidence.
      return {
        grids: {
          ...overview,
          levels: levels.map((level) => ({
            ...level,
            cells: level.cells.map((c) => ({
              ...c,
              bounds: [...c.bounds],
              center: c.center && [...c.center],
            })),
          })),
        },
        capped,
      };
    },
  };
}
