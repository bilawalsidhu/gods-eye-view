import { validateWellPack } from './pack.js';
/** Distinct count-grid contract. Counts describe source locations, never water. */
export const GRID_SIZES = [32, 8, 2, 0.5, 0.125, 0.03125];
// Aggregate input budget, independent from the 2,000-record detail contract.
export const COUNT_LIMIT = 4096;
export const intersects = (a, b) =>
  a[1] < b[3] &&
  a[3] > b[1] &&
  (b[0] <= b[2] ? a[0] < b[2] && a[2] > b[0] : a[2] > b[0] || a[0] < b[2]);
const validCenter = (c, required) => {
  if (!c.center) return !required;
  return (
    Array.isArray(c.center) &&
    c.center.length === 2 &&
    c.center.every(Number.isFinite) &&
    c.center[0] >= c.bounds[0] - 1e-9 &&
    c.center[0] <= c.bounds[2] + 1e-9 &&
    c.center[1] >= c.bounds[1] - 1e-9 &&
    c.center[1] <= c.bounds[3] + 1e-9
  );
};
export function validateCountGrids(value, total) {
  return validateLevels(value, total, GRID_SIZES);
}
export function validateCountOverview(value, total) {
  if (value?.centerMethod !== 'record-mean')
    throw new TypeError('Weighted count overview required');
  return validateLevels(value, total, GRID_SIZES.slice(0, 4));
}
export function validateCountChunk(value, parent, degrees) {
  if (value?.centerMethod !== 'record-mean')
    throw new TypeError('Weighted count chunk required');
  if (
    !GRID_SIZES.slice(4).includes(degrees) ||
    JSON.stringify(value?.parentBounds) !== JSON.stringify(parent.bounds)
  )
    throw new TypeError('Invalid count chunk parent');
  validateLevels(value, parent.count, [degrees]);
  const cells = value.levels[0].cells;
  const weighted = [0, 0];
  for (const c of cells) {
    if (
      c.bounds[0] < parent.bounds[0] ||
      c.bounds[1] < parent.bounds[1] ||
      c.bounds[2] > parent.bounds[2] ||
      c.bounds[3] > parent.bounds[3]
    )
      throw new TypeError('Count chunk outside parent');
    for (let axis = 0; axis < 2; axis++)
      weighted[axis] += c.center[axis] * c.count;
  }
  for (let axis = 0; axis < 2; axis++)
    if (
      Math.abs(weighted[axis] - parent.center[axis] * parent.count) >
      1e-7 * parent.count
    )
      throw new TypeError('Count chunk weighted conservation');
  return value.levels[0];
}
function validateLevels(value, total, sizes) {
  if (
    value?.schemaVersion !== 1 ||
    value.kind !== 'gev-well-count-grids' ||
    value.total !== total ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    value.levels?.length !== sizes.length
  )
    throw new TypeError('Invalid count grids');
  let parents;
  for (let i = 0; i < sizes.length; i++) {
    const size = sizes[i],
      level = value.levels[i];
    if (
      level.degrees !== size ||
      level.total !== total ||
      !Array.isArray(level.cells) ||
      level.cells.length > 250000
    )
      throw new TypeError('Invalid grid level');
    const cells = new Map(),
      sums = new Map();
    let sum = 0;
    for (const c of level.cells) {
      const b = c.bounds;
      if (
        !Array.isArray(b) ||
        b.length !== 4 ||
        !b.every(Number.isFinite) ||
        b[0] < -180 ||
        b[2] > 180 ||
        b[1] < -90 ||
        b[3] > 90 ||
        !Number.isSafeInteger(c.count) ||
        c.count < 1
      )
        throw new TypeError('Invalid count cell');
      const x = (b[0] + 180) / size,
        y = (b[1] + 90) / size;
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        b[2] !== Math.min(180, b[0] + size) ||
        b[3] !== Math.min(90, b[1] + size) ||
        b[0] >= b[2] ||
        b[1] >= b[3]
      )
        throw new TypeError('Unaligned grid');
      const key = `${x}:${y}`;
      if (cells.has(key)) throw new TypeError('Overlapping grid');
      if (!validCenter(c, value.centerMethod === 'record-mean'))
        throw new TypeError('Invalid weighted center');
      cells.set(key, {
        count: c.count,
        x: (c.center?.[0] ?? 0) * c.count,
        y: (c.center?.[1] ?? 0) * c.count,
      });
      sum += c.count;
      if (i) {
        const ratio = sizes[i - 1] / size;
        const p = `${Math.floor(x / ratio)}:${Math.floor(y / ratio)}`;
        const v = sums.get(p) || { count: 0, x: 0, y: 0 };
        v.count += c.count;
        v.x += (c.center?.[0] ?? 0) * c.count;
        v.y += (c.center?.[1] ?? 0) * c.count;
        sums.set(p, v);
      }
    }
    if (
      sum !== total ||
      (parents &&
        (sums.size !== parents.size ||
          [...parents].some(([k, v]) => {
            const s = sums.get(k);
            return (
              !s ||
              s.count !== v.count ||
              (value.centerMethod === 'record-mean' &&
                (Math.abs(s.x - v.x) > 1e-7 * v.count ||
                  Math.abs(s.y - v.y) > 1e-7 * v.count))
            );
          })))
    )
      throw new TypeError('Grid conservation or hierarchy failure');
    parents = cells;
  }
  return value;
}
export function countView(grids, bounds, reason, budget = COUNT_LIMIT) {
  if (!Number.isInteger(budget) || budget < 1 || budget > COUNT_LIMIT)
    throw new TypeError('Invalid cell budget');
  let cells = [];
  let degrees = GRID_SIZES[0];
  for (const level of grids.levels) {
    const next = bounds
      ? level.cells.filter((c) => intersects(c.bounds, bounds))
      : [];
    if (next.length > budget) break;
    cells = next;
    degrees = level.degrees;
  }
  return validateCountView({
    schemaVersion: 1,
    kind: 'gev-well-count-view',
    cells,
    centerMethod: grids.centerMethod,
    degrees,
    total: grids.total,
    reason,
    coverageComplete: false,
  });
}
export function validateCountView(view) {
  if (
    view?.kind !== 'gev-well-count-view' ||
    view.schemaVersion !== 1 ||
    view.coverageComplete !== false ||
    !Array.isArray(view.cells) ||
    view.cells.length > COUNT_LIMIT ||
    !GRID_SIZES.includes(view.degrees) ||
    !Number.isSafeInteger(view.total)
  )
    throw new TypeError('Invalid count view');
  const seen = new Set();
  let sum = 0;
  for (const c of view.cells) {
    const b = c.bounds,
      size = view.degrees;
    if (
      !Array.isArray(b) ||
      b.length !== 4 ||
      !b.every(Number.isFinite) ||
      b[0] < -180 ||
      b[2] > 180 ||
      b[1] < -90 ||
      b[3] > 90 ||
      !Number.isInteger((b[0] + 180) / size) ||
      !Number.isInteger((b[1] + 90) / size) ||
      b[2] !== Math.min(180, b[0] + size) ||
      b[3] !== Math.min(90, b[1] + size) ||
      b[0] >= b[2] ||
      b[1] >= b[3] ||
      !Number.isSafeInteger(c.count) ||
      c.count < 1 ||
      seen.has(JSON.stringify(b))
    )
      throw new TypeError('Invalid count view cell');
    if (!validCenter(c, view.centerMethod === 'record-mean'))
      throw new TypeError('Invalid weighted center');
    seen.add(JSON.stringify(b));
    sum += c.count;
  }
  if (view.detailPack) {
    validateWellPack(view.detailPack);
    for (const r of view.detailPack.records) {
      if (view.cells.some((c) => containsLocation(c.bounds, r)))
        throw new TypeError('Detail overlaps an unreplaced aggregate');
    }
    sum += view.detailPack.records.length;
  }
  if (sum > view.total) throw new TypeError('Invalid count view total');
  return view;
}

// Half-open cells assign a boundary location to exactly one aggregate.
export const containsLocation = (b, r) =>
  r.longitude >= b[0] &&
  (r.longitude < b[2] || (b[2] === 180 && r.longitude === 180)) &&
  r.latitude >= b[1] &&
  (r.latitude < b[3] || (b[3] === 90 && r.latitude === 90));
