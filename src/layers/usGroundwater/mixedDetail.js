import {
  intersects,
  containsLocation,
  validateCountView,
} from './countGrids.js';
import { validateWellPack, WELL_LIMITS } from './pack.js';
import { readTiles } from './tileReads.js';

/** Estimated screen spacing is an eligibility gate, never a precise location. */
export function isDetailResolvable(corners, count) {
  if (
    corners.length !== 4 ||
    count < 1 ||
    corners.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))
  )
    return false;
  const area =
    Math.abs(
      corners.reduce((sum, p, i) => {
        const q = corners[(i + 1) % corners.length];
        return sum + p.x * q.y - q.x * p.y;
      }, 0),
    ) / 2;
  return area / count >= 24 * 24;
}

/** Refine whole counted cells, never subtract a guessed or sampled population.
 * Dense/unloaded cells remain weighted aggregates alongside exact source records.
 */
export async function refineCountView(view, index, load, priority = () => 0) {
  const candidates = view.cells
    .map((cell) => ({ cell, priority: priority(cell) }))
    .filter(
      (v) => v.cell.count <= WELL_LIMITS.sites && Number.isFinite(v.priority),
    )
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.cell.count - b.cell.count ||
        a.cell.bounds.join(':').localeCompare(b.cell.bounds.join(':')),
    );
  const tiles = new Map(),
    selected = new Set();
  let rows = 0,
    bytes = 0;
  // Bounded planning as well as bounded I/O. A crowded cell cannot starve
  // independently affordable sparse cells in the same viewport.
  for (const { cell } of candidates.slice(0, 256)) {
    const required = index.regions.filter((t) =>
      intersects(t.bounds, cell.bounds),
    );
    const extra = required.filter((t) => !tiles.has(t.url));
    const nextRows = rows + extra.reduce((n, t) => n + t.count, 0);
    const nextBytes =
      bytes +
      extra.reduce(
        (n, t) =>
          n +
          (Number.isSafeInteger(t.bytes) && t.bytes > 0
            ? t.bytes
            : WELL_LIMITS.bytes),
        0,
      );
    if (
      !required.length ||
      nextRows > 2000 ||
      nextBytes > 16 * 1024 * 1024 ||
      tiles.size + extra.length > 256
    )
      continue;
    rows = nextRows;
    bytes = nextBytes;
    for (const tile of extra) tiles.set(tile.url, tile);
    selected.add(cell);
  }
  if (!selected.size) return view;
  const records = new Map(),
    acquisitions = new Map();
  const selectedTiles = [...tiles.values()];
  const packs = await readTiles(selectedTiles, load);
  for (const [i, tile] of selectedTiles.entries()) {
    const pack = validateWellPack(packs[i]);
    if (pack.records.length !== tile.count)
      throw new TypeError('Tile accounting mismatch');
    for (const r of pack.records) {
      const b = tile.bounds;
      if (
        r.longitude < b[0] ||
        r.longitude > b[2] ||
        r.latitude < b[1] ||
        r.latitude > b[3]
      )
        throw new TypeError('Tile spatial accounting mismatch');
      if (
        records.has(r.id) &&
        JSON.stringify(records.get(r.id)) !== JSON.stringify(r)
      )
        throw new TypeError('Conflicting source ID');
      records.set(r.id, r);
    }
    for (const a of pack.acquisitions) acquisitions.set(JSON.stringify(a), a);
    if (acquisitions.size > 256)
      return {
        ...view,
        reason: 'Provenance budget; retaining complete counts',
      };
  }
  const exact = new Map();
  for (const cell of selected) {
    const members = [...records.values()].filter((r) =>
      containsLocation(cell.bounds, r),
    );
    if (members.length !== cell.count)
      throw new TypeError('Aggregate/detail reconciliation failed');
    for (const r of members) exact.set(r.id, r);
  }
  const cells = view.cells.filter((c) => !selected.has(c));
  const detailPack = validateWellPack({
    schemaVersion: 1,
    kind: 'gev-us-groundwater-wells',
    mode: 'snapshot',
    catalogTotal: view.total,
    coverage: {
      country: 'US',
      complete: false,
      indexed: true,
      description:
        'Exact source records for fully reconciled cells; other locations remain aggregates. Partial source coverage; consult acquisition and measurement dates.',
    },
    acquisitions: [...acquisitions.values()],
    records: [...exact.values()],
  });
  if (
    exact.size + cells.reduce((n, c) => n + c.count, 0) !==
    view.cells.reduce((n, c) => n + c.count, 0)
  )
    throw new TypeError('Mixed view conservation failed');
  return validateCountView({
    ...view,
    cells,
    detailPack,
    reason: 'Bounded exact detail with complete remaining aggregate counts',
  });
}
