import {
  WILDLIFE_HEIGHT_BANDS,
  WILDLIFE_HEIGHT_HYSTERESIS,
  WILDLIFE_RENDER_LIMIT,
  WILDLIFE_VIEW_PADDING,
} from './policy.js';
import { WILDLIFE_GRID_TARGET_SPACING_PX } from './gridViewport.js';
import { drainWildlifeWork, WILDLIFE_WORK_UNIT } from './performance.js';

const BAND_ORDER = Object.freeze(['cards', 'cells', 'regional', 'global']);
const BAND_THRESHOLDS = Object.freeze([
  WILDLIFE_HEIGHT_BANDS.cards,
  WILDLIFE_HEIGHT_BANDS.cells,
  WILDLIFE_HEIGHT_BANDS.global,
]);

/** A previous band is retained until a boundary is crossed by ten percent. */
export function getWildlifeHeightBand(heightM, previous) {
  const height = Number.isFinite(heightM) ? Math.max(0, heightM) : 0;
  let index = BAND_ORDER.indexOf(previous);
  if (index < 0)
    return BAND_ORDER[
      BAND_THRESHOLDS.filter((boundary) => height > boundary).length
    ];
  while (
    index < BAND_ORDER.length - 1 &&
    height > BAND_THRESHOLDS[index] * (1 + WILDLIFE_HEIGHT_HYSTERESIS)
  )
    index += 1;
  while (
    index > 0 &&
    height < BAND_THRESHOLDS[index - 1] * (1 - WILDLIFE_HEIGHT_HYSTERESIS)
  )
    index -= 1;
  return BAND_ORDER[index];
}

/** Share the legend's animal grouping and unknown fallback with sprites. */
export function wildlifeIconicGroup(iconic) {
  if (iconic === 'Mollusca' || iconic === 'Animalia') return 'Animalia';
  return [
    'Aves',
    'Mammalia',
    'Reptilia',
    'Amphibia',
    'Actinopterygii',
    'Insecta',
    'Arachnida',
    'Plantae',
    'Fungi',
  ].includes(iconic)
    ? iconic
    : 'Unknown';
}

function validIconPosition(row) {
  return (
    Number.isFinite(row?.lat) &&
    Math.abs(row.lat) <= 90 &&
    Number.isFinite(row?.lon) &&
    Math.abs(row.lon) <= 180
  );
}

/** Compare provider IDs consistently across locales. */
export function compareWildlifeIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Prefer a selected/identified recent contact when a population exceeds its
 * cap. Density is never converted into a larger billboard. */
export function wildlifeIconRelevance(row, selectedId = null) {
  return (
    (row.stableId === selectedId ? 1e15 : 0) +
    (row.commonName ? 1e13 : 0) +
    (row.quality === 'research' ? 1e12 : 0) +
    (Number.isFinite(row.observedAt) ? row.observedAt / 1000 : 0)
  );
}

/** Real observations alone compete for 28px screen buckets. Density is an
 * independent visual and can never supply or suppress a sighting's identity.
 * A selected observation keeps its slot even outside the new camera view. */
export function buildWildlifeIconModel(options = {}) {
  return drainWildlifeWork(wildlifeIconModelWork(options));
}

/** Yield bounded units while selecting real observations for screen buckets. */
export function* wildlifeIconModelWork({
  rows = [],
  boxes = null,
  selectedId = null,
  selectedRow = null,
  preferredIds = [],
  limit = WILDLIFE_RENDER_LIMIT,
  projectRow = null,
  onOperations = null,
} = {}) {
  const operations = {
    observationVisits: 0,
    projections: 0,
    rankComparisons: 0,
  };
  const preferred = new Set(preferredIds);
  const seen = new Set();
  const buckets = new Map();
  let sightingCount = 0;
  let acartiaCount = 0;
  const score = (row) =>
    wildlifeIconRelevance(row, selectedId) +
    (preferred.has(row.stableId) ? 1e14 : 0);
  const candidates =
    selectedRow && !rows.includes(selectedRow) ? [...rows, selectedRow] : rows;
  yield 'bucket';
  for (const row of candidates) {
    if (
      operations.observationVisits &&
      operations.observationVisits % WILDLIFE_WORK_UNIT === 0
    )
      yield 'bucket';
    operations.observationVisits++;
    if (
      typeof row?.stableId !== 'string' ||
      !row.stableId.length ||
      !validIconPosition(row) ||
      seen.has(row.stableId)
    )
      continue;
    seen.add(row.stableId);
    const selected = row.stableId === selectedId;
    const inView = rowInWildlifeBoxes(row, boxes, 0);
    if (!selected && !inView) continue;
    let key = row.stableId;
    let visible = inView;
    if (typeof projectRow === 'function') {
      operations.projections++;
      const screen = projectRow(row);
      visible &&=
        !!screen && Number.isFinite(screen.x) && Number.isFinite(screen.y);
      if (!visible && !selected) continue;
      if (visible) {
        const x = Math.floor(screen.x / WILDLIFE_GRID_TARGET_SPACING_PX);
        const y = Math.floor(screen.y / WILDLIFE_GRID_TARGET_SPACING_PX);
        key =
          Math.abs(x) < 1048576 && Math.abs(y) < 1048576
            ? x * 2097152 + y
            : `${x}:${y}`;
      }
    }
    if (visible) {
      sightingCount++;
      if (row.origin === 'acartia') acartiaCount++;
    }
    const incumbent = buckets.get(key);
    if (
      !incumbent ||
      score(row) > score(incumbent) ||
      (score(row) === score(incumbent) && row.stableId < incumbent.stableId)
    )
      buckets.set(key, row);
  }
  yield 'rank';
  const population = [...buckets.values()];
  const cap = Math.max(selectedId ? 1 : 0, Math.floor(limit));
  const saturated = population.length > cap;
  if (saturated)
    population.sort((a, b) => {
      operations.rankComparisons++;
      return score(b) - score(a) || compareWildlifeIds(a.stableId, b.stableId);
    });
  onOperations?.(operations);
  return {
    rows: saturated ? population.slice(0, cap) : population,
    saturated,
    totalPoints: population.length,
    sightingCount,
    acartiaCount,
  };
}

/** Test the padded view in degrees, including across the antimeridian. Null
 * boxes are the global sample, whose rows all remain candidates. */
export function rowInWildlifeBoxes(
  row,
  boxes,
  padding = WILDLIFE_VIEW_PADDING,
) {
  if (!Number.isFinite(row?.lat) || !Number.isFinite(row?.lon)) return false;
  if (!Array.isArray(boxes)) return true;
  for (const box of boxes) {
    const latPad = (box.north - box.south) * padding;
    const width =
      box.east >= box.west ? box.east - box.west : 360 - box.west + box.east;
    const lonPad = width * padding;
    if (
      row.lat < Math.max(-90, box.south - latPad) ||
      row.lat > Math.min(90, box.north + latPad)
    )
      continue;
    const relative = row.lon - box.west;
    if (relative >= -lonPad && relative <= width + lonPad) return true;
    if (relative + 360 >= -lonPad && relative + 360 <= width + lonPad)
      return true;
    if (relative - 360 >= -lonPad && relative - 360 <= width + lonPad)
      return true;
  }
  return false;
}
