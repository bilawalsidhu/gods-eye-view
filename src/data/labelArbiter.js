import {
  ALLOCATION_ELASTIC,
  ALLOCATION_WEIGHTED,
  normalizeAllocationStrategy,
} from './detectionPolicy.js';

const CELL_SIZE_PX = 32;
const EMPTY_CANDIDATES = Object.freeze([]);
const FADE_IN_MS = 150;
const FADE_OUT_MS = 300;
const MIN_LIFETIME_MS = 2500;
const COOLDOWN_MS = 1200;

/**
 * Floor and clamp a possibly-garbage number into a bounded integer.
 * @param {*} value Raw value; non-numeric input reads as 0.
 * @param {number} min Inclusive lower bound.
 * @param {number} max Inclusive upper bound.
 * @returns {number} Truncated integer within [min, max].
 */
function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.floor(Number(value) || 0)));
}

/**
 * Normalize a layer demand map into sorted, positive [layerId, count] pairs.
 * @param {Map<string, number>|{[key: string]: number}|null} demandByLayer Raw
 *   demand in either collection form; null reads as empty.
 * @returns {Array<[string, number]>} Pairs sorted by layer id, zero/negative
 *   and non-numeric counts dropped, so iteration order is stable.
 */
function demandEntries(demandByLayer) {
  const entries = demandByLayer instanceof Map
    ? Array.from(demandByLayer.entries())
    : Object.entries(demandByLayer || {});
  return entries
    .map(([layerId, demand]) => [String(layerId), Math.max(0, Math.floor(Number(demand) || 0))])
    .filter(([, demand]) => demand > 0)
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Hand out entitlement a layer could not use to layers that still want it.
 * @param {Map<string,number>} quotas Quota per layer, mutated in place.
 * @param {Map<string,number>} demand Per-layer demand ceiling.
 * @param {number} capacity Total label budget to reach.
 * @param {Array<string>} order Layer ids to sweep in — deterministic fill
 *   order, which is what makes the whole allocation reproducible.
 * @returns {Map<string,number>} The same `quotas` map.
 */
function redistributeUnused(quotas, demand, capacity, order) {
  let used = Array.from(quotas.values()).reduce((sum, value) => sum + value, 0);
  while (used < capacity) {
    let changed = false;
    for (const layerId of order) {
      const current = quotas.get(layerId) || 0;
      if (current >= (demand.get(layerId) || 0)) continue;
      quotas.set(layerId, current + 1);
      used++;
      changed = true;
      if (used >= capacity) break;
    }
    if (!changed) break;
  }
  return quotas;
}

/**
 * Pooled twin of allocateLayerQuotas: same arithmetic, no allocation. Every
 * array is a module-instance scratch buffer reused across solves.
 * @param {Map<string,number>} demand Per-layer demand, already normalized.
 * @param {number} capacity Total label budget.
 * @param {string} strategy 'ELASTIC' or 'WEIGHTED'.
 * @param {[key: string]: number} layerWeights Per-layer semantic weights used
 *   by the weighted strategy; null/omitted weights default to 1.
 * @param {Array<string>} ids Active layer ids, sorted.
 * @param {number} idCount How many of `ids` are live.
 * @param {Map<string,number>} quotas Output map, cleared and refilled.
 * @param {Array<object>} weighted Scratch for weighted entries.
 * @param {Array<object>} priorityOrder Scratch for weight-sorted entries.
 * @param {Array<object>} remainders Scratch for largest-remainder entries.
 * @returns {Map<string,number>} The same `quotas` map, layer→quota.
 */
function allocateLayerQuotasInto(
  demand,
  capacity,
  strategy,
  layerWeights,
  ids,
  idCount,
  quotas,
  weighted,
  priorityOrder,
  remainders,
) {
  quotas.forEach((value, layerId) => {
    if (!demand.has(layerId)) quotas.delete(layerId);
  });
  for (let i = 0; i < idCount; i++) quotas.set(ids[i], 0);
  if (capacity === 0 || idCount === 0) return quotas;

  if (strategy === ALLOCATION_ELASTIC) {
    const base = Math.floor(capacity / idCount);
    let remainder = capacity % idCount;
    let used = 0;
    for (let i = 0; i < idCount; i++) {
      const layerId = ids[i];
      const entitlement = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      const quota = Math.min(demand.get(layerId) || 0, entitlement);
      quotas.set(layerId, quota);
      used += quota;
    }
    while (used < capacity) {
      let changed = false;
      for (let i = 0; i < idCount && used < capacity; i++) {
        const layerId = ids[i];
        const current = quotas.get(layerId) || 0;
        if (current >= (demand.get(layerId) || 0)) continue;
        quotas.set(layerId, current + 1);
        used++;
        changed = true;
      }
      if (!changed) break;
    }
    return quotas;
  }

  let totalWeight = 0;
  for (let i = 0; i < idCount; i++) {
    const layerId = ids[i];
    const count = demand.get(layerId) || 0;
    const semanticWeight = Math.max(0.05, Number(layerWeights?.[layerId]) || 1);
    const entry = weighted[i] || (weighted[i] = {});
    entry.layerId = layerId;
    entry.count = count;
    entry.weight = Math.sqrt(count) * semanticWeight;
    entry.fraction = 0;
    priorityOrder[i] = entry;
    remainders[i] = entry;
    totalWeight += entry.weight;
  }
  weighted.length = idCount;
  priorityOrder.length = idCount;
  remainders.length = idCount;
  priorityOrder.sort((a, b) => b.weight - a.weight || a.layerId.localeCompare(b.layerId));

  let remaining = capacity;
  if (capacity >= idCount) {
    for (let i = 0; i < idCount; i++) quotas.set(ids[i], 1);
    remaining -= idCount;
  }
  if (remaining > 0 && totalWeight > 0) {
    let apportioned = 0;
    for (let i = 0; i < idCount; i++) {
      const entry = weighted[i];
      const exact = remaining * entry.weight / totalWeight;
      const room = entry.count - (quotas.get(entry.layerId) || 0);
      const whole = Math.min(room, Math.floor(exact));
      quotas.set(entry.layerId, (quotas.get(entry.layerId) || 0) + whole);
      apportioned += whole;
      entry.fraction = exact - Math.floor(exact);
    }
    remaining -= apportioned;
    remainders.sort((a, b) => b.fraction - a.fraction
      || b.weight - a.weight
      || a.layerId.localeCompare(b.layerId));
    for (let i = 0; i < idCount && remaining > 0; i++) {
      const entry = remainders[i];
      const current = quotas.get(entry.layerId) || 0;
      if (current >= (demand.get(entry.layerId) || 0)) continue;
      quotas.set(entry.layerId, current + 1);
      remaining--;
    }
  }

  let used = 0;
  for (let i = 0; i < idCount; i++) used += quotas.get(ids[i]) || 0;
  while (used < capacity) {
    let changed = false;
    for (let i = 0; i < idCount && used < capacity; i++) {
      const layerId = priorityOrder[i].layerId;
      const current = quotas.get(layerId) || 0;
      if (current >= (demand.get(layerId) || 0)) continue;
      quotas.set(layerId, current + 1);
      used++;
      changed = true;
    }
    if (!changed) break;
  }
  return quotas;
}

/**
 * Allocate a collective capacity across non-empty layers. Both strategies are
 * work-conserving and deterministic; unused entitlement is always borrowed.
 *
 * @param {Map<string, number>|{[key: string]: number}} demandByLayer How many
 *   labels each layer wants; any layer absent or zero receives nothing.
 * @param {number} capacity Total label budget shared across layers.
 * @param {string} [strategy] 'ELASTIC' splits evenly then borrows; 'WEIGHTED'
 *   seeds one label per layer and apportions the rest by sqrt(count) × weight.
 * @param {[key: string]: number} [layerWeights] Semantic per-layer weights for
 *   the weighted strategy; unknown layers default to 1.
 * @returns {Map<string, number>} layerId→quota, summing to at most `capacity`
 *   and never exceeding per-layer demand.
 */
export function allocateLayerQuotas(demandByLayer, capacity, strategy = ALLOCATION_ELASTIC, layerWeights = {}) {
  const entries = demandEntries(demandByLayer);
  const totalDemand = entries.reduce((sum, [, demand]) => sum + demand, 0);
  const cap = clampInt(capacity, 0, totalDemand);
  const quotas = new Map(entries.map(([layerId]) => [layerId, 0]));
  if (cap === 0 || entries.length === 0) return quotas;

  const demand = new Map(entries);
  const ids = entries.map(([layerId]) => layerId);
  const normalizedStrategy = normalizeAllocationStrategy(strategy);

  if (normalizedStrategy === ALLOCATION_ELASTIC) {
    const base = Math.floor(cap / ids.length);
    let remainder = cap % ids.length;
    for (const layerId of ids) {
      const entitlement = base + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);
      quotas.set(layerId, Math.min(demand.get(layerId), entitlement));
    }
    return redistributeUnused(quotas, demand, cap, ids);
  }

  const weighted = entries.map(([layerId, count]) => {
    const semanticWeight = Math.max(0.05, Number(layerWeights[layerId]) || 1);
    return { layerId, count, weight: Math.sqrt(count) * semanticWeight };
  });
  const priorityOrder = weighted
    .slice()
    .sort((a, b) => b.weight - a.weight || a.layerId.localeCompare(b.layerId))
    .map((entry) => entry.layerId);

  let remaining = cap;
  if (cap >= ids.length) {
    for (const layerId of ids) quotas.set(layerId, 1);
    remaining -= ids.length;
  }

  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  const remainders = [];
  if (remaining > 0 && totalWeight > 0) {
    let apportioned = 0;
    for (const entry of weighted) {
      const exact = remaining * entry.weight / totalWeight;
      const room = entry.count - (quotas.get(entry.layerId) || 0);
      const whole = Math.min(room, Math.floor(exact));
      quotas.set(entry.layerId, (quotas.get(entry.layerId) || 0) + whole);
      apportioned += whole;
      remainders.push({ layerId: entry.layerId, fraction: exact - Math.floor(exact), weight: entry.weight });
    }
    remaining -= apportioned;
    remainders.sort((a, b) => b.fraction - a.fraction || b.weight - a.weight || a.layerId.localeCompare(b.layerId));
    for (const entry of remainders) {
      if (remaining <= 0) break;
      const current = quotas.get(entry.layerId) || 0;
      if (current >= demand.get(entry.layerId)) continue;
      quotas.set(entry.layerId, current + 1);
      remaining--;
    }
  }

  return redistributeUnused(quotas, demand, cap, priorityOrder);
}

/**
 * Whether a rectangle is usable for placement math.
 * @param {?{x:number,y:number,w:number,h:number}} rect Candidate rectangle.
 * @returns {boolean} True only when all four fields are finite and both extents
 *   are strictly positive — a zero-area rect would collide with everything.
 */
function rectIsFinite(rect) {
  return rect
    && Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && Number.isFinite(rect.w)
    && Number.isFinite(rect.h)
    && rect.w > 0
    && rect.h > 0;
}

/**
 * Axis-aligned overlap test with an outward padding margin.
 * @param {{x:number,y:number,w:number,h:number}} a First rectangle.
 * @param {{x:number,y:number,w:number,h:number}} b Second rectangle.
 * @param {number} [padding] Extra gap in px required between rectangles.
 * @returns {boolean} True when the inflated rectangles intersect.
 */
function overlaps(a, b, padding = 4) {
  return a.x < b.x + b.w + padding
    && a.x + a.w + padding > b.x
    && a.y < b.y + b.h + padding
    && a.y + a.h + padding > b.y;
}

const CELL_ORIGIN = 8192;

/**
 * Reusable uniform grid over placement rectangles. Buckets and their numeric
 * cell keys survive across solves; the previous contents are invalidated by a
 * generation stamp instead of rebuilding a Map of string-keyed arrays. The
 * duplicate-visit set the original kept is unnecessary — `overlaps` is pure, so
 * re-testing the same rectangle in a second cell returns the same answer.
 */
class SpatialHash {
  constructor(cellSize = CELL_SIZE_PX) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.generation = 0;
  }

  reset() {
    this.generation++;
  }

  clear() {
    this.cells.clear();
    this.generation = 0;
  }

  /**
   * Pack a cell coordinate pair into one Smi. Coordinates are clamped to
   * +/-8192 cells (+/-262,144 px at the 32 px cell size) so the key stays a
   * Smi; anything beyond that folds into the edge cells. The clamp is
   * conservative, never lossy: two overlapping rectangles always share at
   * least one unclamped cell, which maps to the same clamped key, so folding
   * can only add candidate comparisons — `overlaps` still decides — and can
   * never hide a real collision.
   *
   * @param {number} x Cell x index, may be negative.
   * @param {number} y Cell y index, may be negative.
   * @returns {number} Packed 28-bit integer key for the cells Map.
   */
  _cellKey(x, y) {
    const cx = Math.max(-CELL_ORIGIN, Math.min(CELL_ORIGIN - 1, x)) + CELL_ORIGIN;
    const cy = Math.max(-CELL_ORIGIN, Math.min(CELL_ORIGIN - 1, y)) + CELL_ORIGIN;
    // Both coordinates occupy 14 bits. Bit-packing forces the lookup key to a
    // Smi; arithmetic multiplication materializes a boxed double at each
    // spatial-hash get/add on this hot solve path.
    return (cx << 14) | cy;
  }

  collides(rect) {
    const size = this.cellSize;
    const x1 = Math.floor((rect.x + rect.w) / size);
    const y1 = Math.floor((rect.y + rect.h) / size);
    for (let y = Math.floor(rect.y / size); y <= y1; y++) {
      for (let x = Math.floor(rect.x / size); x <= x1; x++) {
        const bucket = this.cells.get(this._cellKey(x, y));
        if (!bucket || bucket.generation !== this.generation) continue;
        for (let i = 0; i < bucket.count; i++) {
          if (overlaps(rect, bucket.rects[i])) return true;
        }
      }
    }
    return false;
  }

  add(rect) {
    const size = this.cellSize;
    const x1 = Math.floor((rect.x + rect.w) / size);
    const y1 = Math.floor((rect.y + rect.h) / size);
    for (let y = Math.floor(rect.y / size); y <= y1; y++) {
      for (let x = Math.floor(rect.x / size); x <= x1; x++) {
        const key = this._cellKey(x, y);
        let bucket = this.cells.get(key);
        if (!bucket) {
          bucket = { generation: this.generation, count: 0, rects: [] };
          this.cells.set(key, bucket);
        } else if (bucket.generation !== this.generation) {
          bucket.generation = this.generation;
          bucket.count = 0;
        }
        bucket.rects[bucket.count++] = rect;
      }
    }
  }
}

// Only the sign of a sort comparator is observed, so every branch returns a
// small integer. A fractional (double) result would be boxed on the way out of
// the comparator on every comparison of every solve.
/**
 * Total order over candidates: lifetime-pinned incumbents first, then plain
 * incumbents, then priority, keyhole visibility, and center proximity, with the
 * key as the final deterministic tiebreak.
 * @param {object} a First candidate.
 * @param {object} b Second candidate.
 * @param {Map<string,object>} states Per-key label state used for incumbency
 *   and pinning.
 * @param {number} now Frame timestamp the lifetime window is measured from.
 * @returns {number} Negative when `a` sorts before `b`, positive after, 0 never
 *   reaching for distinct keys because the key compare is last.
 */
function candidateCompare(a, b, states, now) {
  const aState = states.get(a.key);
  const bState = states.get(b.key);
  // A stateless candidate is never lifetime-pinned: its source shipped as a
  // per-frame rebuild, so it must be free to lose its slot the moment something
  // better wants it. Plain incumbency ordering below still applies.
  const aPinned = Boolean(aState?.selected) && a.stateless !== true && now - aState.selectedAt < MIN_LIFETIME_MS;
  const bPinned = Boolean(bState?.selected) && b.stateless !== true && now - bState.selectedAt < MIN_LIFETIME_MS;
  if (aPinned !== bPinned) return aPinned ? -1 : 1;
  const aIncumbent = Boolean(aState?.selected);
  const bIncumbent = Boolean(bState?.selected);
  if (aIncumbent !== bIncumbent) return aIncumbent ? -1 : 1;
  const aPriority = Number(a.priority) || 0;
  const bPriority = Number(b.priority) || 0;
  if (aPriority !== bPriority) return bPriority > aPriority ? 1 : -1;
  const aAlpha = Number(a.keyholeAlpha) || 0;
  const bAlpha = Number(b.keyholeAlpha) || 0;
  if (aAlpha !== bAlpha) return bAlpha > aAlpha ? 1 : -1;
  const aDistance = Number(a.centerDistance) || 0;
  const bDistance = Number(b.centerDistance) || 0;
  if (aDistance !== bDistance) return aDistance > bDistance ? 1 : -1;
  return String(a.key).localeCompare(String(b.key));
}

/**
 * Cache a candidate's spread anchor in its own object so the queue reads plain
 * doubles instead of re-deriving geometry on every comparison.
 * @param {object} candidate Candidate to annotate with `_anchorX`/`_anchorY`;
 *   prefers the projected point, then a lead line origin, then a rect center.
 * @returns {void}
 */
function cacheCandidateAnchorScalars(candidate) {
  let anchorX = Number.NaN;
  let anchorY = Number.NaN;
  if (Number.isFinite(candidate?.screenX) && Number.isFinite(candidate?.screenY)) {
    anchorX = candidate.screenX;
    anchorY = candidate.screenY;
  } else {
    const placement = Array.isArray(candidate?.placements) ? candidate.placements[0] : null;
    if (Number.isFinite(placement?.leadFromX) && Number.isFinite(placement?.leadFromY)) {
      anchorX = placement.leadFromX;
      anchorY = placement.leadFromY;
    } else if (rectIsFinite(placement?.rect)) {
      anchorX = placement.rect.x + placement.rect.w * 0.5;
      anchorY = placement.rect.y + placement.rect.h * 0.5;
    }
  }
  candidate._anchorX = anchorX;
  candidate._anchorY = anchorY;
}

/**
 * Coarse visibility rank used as the queue's second sort key.
 * @param {object} candidate Candidate carrying `keyholeAlpha`.
 * @returns {number} 0-8 band; full visibility saturates at 8 so everything at
 *   alpha >= 0.999 ties instead of splitting hairs.
 */
function visibilityBand(candidate) {
  const alpha = Math.max(0, Math.min(1, Number(candidate?.keyholeAlpha) || 0));
  return alpha >= 0.999 ? 8 : Math.floor(alpha * 8);
}

/**
 * Incremental farthest-point selector for new labels. Semantic priority and
 * keyhole visibility remain primary; spatial separation only breaks ties.
 * This prevents the first solve from walking inward-to-outward by
 * centerDistance and packing an equal-priority satellite cohort around Earth.
 */
class SpatialCandidateQueue {
  constructor() {
    this.candidates = null;
    this.count = 0;
    this.anchorCount = 0;
    this.distances = new Float64Array(0);
    this.anchorXs = new Float64Array(0);
    this.anchorYs = new Float64Array(0);
    this.placementMasks = new Uint8Array(0);
    this.placementXs = new Float64Array(0);
    this.placementYs = new Float64Array(0);
    this.placementWs = new Float64Array(0);
    this.placementHs = new Float64Array(0);
    this.seedAnchorXs = new Float64Array(0);
    this.seedAnchorYs = new Float64Array(0);
    this.attemptStamps = null;
    this.stamp = 0;
    this.spatial = null;
    this.states = null;
  }

  /**
   * Re-target the queue at a caller-owned candidate slice. Per-candidate
   * spread state lives in a pooled numeric buffer, so computed squared doubles
   * stay unboxed. Few-placement candidates already blocked by the
   * monotonically growing collision field are dismissed before anchor scans.
   *
   * @param {Array<object>} candidates Caller-owned slice for this layer.
   * @param {number} count How many of `candidates` are live.
   * @param {Array<object>} anchors Already-selected candidates seeding the
   *   farthest-point metric; each carries cached `_anchorX`/`_anchorY`.
   * @param {number} anchorCount How many of `anchors` are live.
   * @param {Map<string,number>} attemptStamps Key→stamp map marking keys
   *   already tried this solve.
   * @param {number} stamp Current solve's stamp.
   * @param {SpatialHash} spatial Shared occupancy grid.
   * @param {Map<string,object>} states Per-key arbiter state, used to seed
   *   spread distances and to resolve sticky corners in dismissal.
   * @returns {void}
   */
  reset(candidates, count, anchors, anchorCount, attemptStamps, stamp, spatial, states) {
    this.candidates = candidates;
    this.count = count;
    this.anchorCount = anchorCount;
    this.attemptStamps = attemptStamps;
    this.stamp = stamp;
    this.spatial = spatial;
    this.states = states;
    if (this.distances.length < count) {
      let capacity = Math.max(16, this.distances.length);
      while (capacity < count) capacity *= 2;
      this.distances = new Float64Array(capacity);
      this.anchorXs = new Float64Array(capacity);
      this.anchorYs = new Float64Array(capacity);
      this.placementMasks = new Uint8Array(capacity);
      this.placementXs = new Float64Array(capacity * 4);
      this.placementYs = new Float64Array(capacity * 4);
      this.placementWs = new Float64Array(capacity * 4);
      this.placementHs = new Float64Array(capacity * 4);
    }
    if (this.seedAnchorXs.length < anchorCount) {
      let anchorCapacity = Math.max(16, this.seedAnchorXs.length);
      while (anchorCapacity < anchorCount) anchorCapacity *= 2;
      this.seedAnchorXs = new Float64Array(anchorCapacity);
      this.seedAnchorYs = new Float64Array(anchorCapacity);
    }
    for (let i = 0; i < anchorCount; i++) {
      this.seedAnchorXs[i] = anchors[i]._anchorX;
      this.seedAnchorYs[i] = anchors[i]._anchorY;
    }
    for (let i = 0; i < count; i++) {
      const candidate = candidates[i];
      this.distances[i] = Number.POSITIVE_INFINITY;
      this.anchorXs[i] = candidate._anchorX;
      this.anchorYs[i] = candidate._anchorY;
      this.placementMasks[i] = 255;
      if (attemptStamps.get(candidate.key) === stamp) continue;
      const placements = candidate.placements;
      if (!Array.isArray(placements) || placements.length > 4) continue;
      let freeMask = 0;
      for (let p = 0; p < placements.length; p++) {
        const rect = placements[p]?.rect;
        if (!rectIsFinite(rect)) continue;
        const rectIndex = i * 4 + p;
        this.placementXs[rectIndex] = rect.x;
        this.placementYs[rectIndex] = rect.y;
        this.placementWs[rectIndex] = rect.w;
        this.placementHs[rectIndex] = rect.h;
        if (!spatial.collides(rect)) freeMask |= 1 << p;
      }
      this.placementMasks[i] = freeMask;
      if (freeMask === 0) this._dismissBlockedKey(i);
    }
    for (let i = 0; i < count; i++) {
      const candidate = candidates[i];
      if (attemptStamps.get(candidate.key) === stamp) continue;
      const pointX = this.anchorXs[i];
      const pointY = this.anchorYs[i];
      if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) continue;
      let minimumDistanceSq = Number.POSITIVE_INFINITY;
      for (let a = 0; a < anchorCount; a++) {
        const dx = pointX - this.seedAnchorXs[a];
        const dy = pointY - this.seedAnchorYs[a];
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq < minimumDistanceSq) minimumDistanceSq = distanceSq;
      }
      this.distances[i] = minimumDistanceSq;
    }
  }

  /**
   * Dismiss a blocked few-placement identity once. Collision occupancy only
   * grows during a solve, so it can never become placeable later. Duplicate
   * keys retain their historical single-attempt semantics: a free duplicate
   * prevents the shared key from being dismissed.
   *
   * @param {number} index Index into the queue's candidate slice.
   * @returns {boolean} True when the key was dismissed for this solve.
   */
  _dismissBlockedKey(index) {
    const candidate = this.candidates[index];
    const sticky = this.states.get(candidate.key)?.corner;
    if (firstFreePlacement(candidate, sticky, this.spatial)) {
      this.placementMasks[index] = 255;
      return false;
    }
    for (let i = 0; i < this.count; i++) {
      if (i === index) continue;
      const duplicate = this.candidates[i];
      if (duplicate.key !== candidate.key) continue;
      const duplicateSticky = this.states.get(duplicate.key)?.corner;
      if (firstFreePlacement(duplicate, duplicateSticky, this.spatial)) {
        this.placementMasks[i] = 255;
        return false;
      }
    }
    this.attemptStamps.set(candidate.key, this.stamp);
    return true;
  }

  addAnchor(candidate, placement) {
    const anchorX = candidate?._anchorX;
    const anchorY = candidate?._anchorY;
    if (!Number.isFinite(anchorX) || !Number.isFinite(anchorY)) return;
    this.anchorCount++;
    const distances = this.distances;
    const anchorXs = this.anchorXs;
    const anchorYs = this.anchorYs;
    const placementMasks = this.placementMasks;
    const placementXs = this.placementXs;
    const placementYs = this.placementYs;
    const placementWs = this.placementWs;
    const placementHs = this.placementHs;
    const anchorRect = placement?.rect;
    const anchorRectX = anchorRect?.x;
    const anchorRectY = anchorRect?.y;
    const anchorRectW = anchorRect?.w;
    const anchorRectH = anchorRect?.h;
    for (let i = 0; i < this.count; i++) {
      const other = this.candidates[i];
      if (this.attemptStamps.get(other.key) === this.stamp) continue;
      if (placementMasks[i] !== 255) {
        let freeMask = placementMasks[i];
        for (let p = 0; freeMask !== 0 && p < other.placements.length; p++) {
          const bit = 1 << p;
          if ((freeMask & bit) === 0) continue;
          const rectIndex = i * 4 + p;
          const rectX = placementXs[rectIndex];
          const rectY = placementYs[rectIndex];
          const rectW = placementWs[rectIndex];
          const rectH = placementHs[rectIndex];
          if (rectX < anchorRectX + anchorRectW + 4
            && rectX + rectW + 4 > anchorRectX
            && rectY < anchorRectY + anchorRectH + 4
            && rectY + rectH + 4 > anchorRectY) freeMask &= ~bit;
        }
        placementMasks[i] = freeMask;
        if (freeMask === 0 && this._dismissBlockedKey(i)) continue;
      }
      const pointX = anchorXs[i];
      const pointY = anchorYs[i];
      if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) continue;
      const dx = pointX - anchorX;
      const dy = pointY - anchorY;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < distances[i]) distances[i] = distanceSq;
    }
  }

  next(attemptStamps, stamp) {
    let best = null;
    let bestIndex = -1;
    for (let i = 0; i < this.count; i++) {
      const candidate = this.candidates[i];
      if (attemptStamps.get(candidate.key) === stamp) continue;
      if (!best) {
        best = candidate;
        bestIndex = i;
        continue;
      }
      const priorityDelta = (Number(candidate.priority) || 0) - (Number(best.priority) || 0);
      if (priorityDelta !== 0) {
        if (priorityDelta > 0) {
          best = candidate;
          bestIndex = i;
        }
        continue;
      }
      const visibilityDelta = visibilityBand(candidate) - visibilityBand(best);
      if (visibilityDelta !== 0) {
        if (visibilityDelta > 0) {
          best = candidate;
          bestIndex = i;
        }
        continue;
      }
      if (this.anchorCount > 0) {
        const spreadDelta = this.distances[i] - this.distances[bestIndex];
        if (spreadDelta !== 0) {
          if (spreadDelta > 0) {
            best = candidate;
            bestIndex = i;
          }
          continue;
        }
      }
      if (String(candidate.key).localeCompare(String(best.key)) < 0) {
        best = candidate;
        bestIndex = i;
      }
    }
    return best;
  }
}

/**
 * First placement in the canonical attempt order — finite rectangles only,
 * sticky corner first. Equivalent to the head of the filtered/stable-sorted
 * list the original built, without materializing it.
 *
 * @param {object} candidate Candidate carrying a `placements` array.
 * @param {?string} stickyCorner Corner name to prefer, or null when unset.
 * @returns {?object} First finite placement, or null when none is finite.
 */
function firstOrderedPlacement(candidate, stickyCorner) {
  const placements = candidate?.placements;
  if (!Array.isArray(placements)) return null;
  let first = null;
  for (let i = 0; i < placements.length; i++) {
    const placement = placements[i];
    if (!rectIsFinite(placement?.rect)) continue;
    if (stickyCorner && placement.corner === stickyCorner) return placement;
    first ||= placement;
  }
  return first;
}

/**
 * Walk the canonical attempt order and return the first placement the spatial
 * hash accepts. The collision probes happen in exactly the original order.
 *
 * @param {object} candidate Candidate carrying a `placements` array.
 * @param {?string} stickyCorner Corner name tried first, before the canonical order.
 * @param {SpatialHash} spatial Occupancy grid to probe against.
 * @returns {?object} The first unoccupied placement, or null when every
 *   candidate position collides.
 */
function firstFreePlacement(candidate, stickyCorner, spatial) {
  const placements = candidate?.placements;
  if (!Array.isArray(placements)) return null;
  if (stickyCorner) {
    for (let i = 0; i < placements.length; i++) {
      const placement = placements[i];
      if (placement?.corner !== stickyCorner || !rectIsFinite(placement.rect)) continue;
      if (!spatial.collides(placement.rect)) return placement;
    }
  }
  for (let i = 0; i < placements.length; i++) {
    const placement = placements[i];
    if (!rectIsFinite(placement?.rect)) continue;
    if (stickyCorner && placement.corner === stickyCorner) continue;
    if (!spatial.collides(placement.rect)) return placement;
  }
  return null;
}

/**
 * Per-solve identity used by the key-stamp maps. A module-level counter keeps
 * stamps unique across every arbiter instance sharing a candidate object.
 */
let _globalSolveStamp = 0;

/**
 * Drop a stamp index once it holds far more keys than the live cohort.
 * @param {Map<string,number>} map Stamp map to shrink; cleared wholesale, which
 *   is safe because a missing entry and a stale entry behave identically.
 * @param {number} liveCount Candidates in the current solve.
 * @returns {void}
 */
function pruneStampMap(map, liveCount) {
  if (map.size > liveCount * 4 + 64) map.clear();
}

/**
 * Empty a pooled layer bucket in place, keeping its candidate array allocated.
 * @param {{list: Array<object>, count: number}} bucket Bucket to reset.
 * @returns {void}
 */
function resetLayerBucket(bucket) {
  bucket.count = 0;
}

/** Ranges up to this size keep the in-place insertion sort. */
const INSERTION_SORT_MAX = 32;

/**
 * Shared merge scratch for the large-cohort sort path. Grown geometrically
 * and reused across solves — a solve must not allocate (the allocation gate
 * samples solve-time bytes and counts Array#sort/filter/slice/push calls),
 * so the merge buffer outlives the call.
 * @type {Array}
 */
const mergeScratch = [];

/**
 * Stable in-place sort over a pooled array prefix. Fixed-width runs are
 * insertion-sorted (frame-to-frame a small cohort is nearly sorted, and the
 * insertion pass allocates nothing); runs are then bottom-up merged through
 * the shared scratch. This replaced a whole-prefix insertion sort whose
 * quadratic pass dominated DENSE-mode solves — the cohort arrives in
 * cohort order, not comparison order, so inversions are near-maximal every
 * solve (measured: ~63% of solve CPU at 3300 candidates). Merge order takes
 * the left run on ties, which reproduces the insertion sort's stable
 * ordering bit-for-bit.
 *
 * @param {Array<object>} items Pooled array whose prefix [0, count) is sorted
 *   in place; entries past `count` are ignored.
 * @param {number} count Number of live entries at the head of `items`.
 * @param {Map<string,object>} states Per-key arbiter state handed to the comparator.
 * @param {number} now Frame timestamp handed to the comparator.
 * @returns {void}
 */
function sortCandidateRange(items, count, states, now) {
  const width = INSERTION_SORT_MAX;
  for (let start = 0; start < count; start += width) {
    const end = Math.min(start + width, count);
    for (let i = start + 1; i < end; i++) {
      const item = items[i];
      let j = i - 1;
      while (j >= start && candidateCompare(items[j], item, states, now) > 0) {
        items[j + 1] = items[j];
        j--;
      }
      items[j + 1] = item;
    }
  }
  if (count <= width) return;

  if (mergeScratch.length < count) mergeScratch.length = 2 * count;
  let src = items;
  let dst = mergeScratch;
  for (let w = width; w < count; w *= 2) {
    for (let lo = 0; lo < count; lo += 2 * w) {
      const mid = Math.min(lo + w, count);
      const hi = Math.min(lo + 2 * w, count);
      let i = lo;
      let j = mid;
      let k = lo;
      while (i < mid && j < hi) {
        if (candidateCompare(src[j], src[i], states, now) >= 0) dst[k++] = src[i++];
        else dst[k++] = src[j++];
      }
      while (i < mid) dst[k++] = src[i++];
      while (j < hi) dst[k++] = src[j++];
    }
    const swap = src;
    src = dst;
    dst = swap;
  }
  if (src !== items) {
    for (let i = 0; i < count; i++) items[i] = src[i];
  }
}

/**
 * Resolve the current render placement without materializing or sorting an
 * intermediate list. This is equivalent to `orderedPlacements(...).find(...)`
 * for every finite-placement/sticky-corner combination used by renderEntries.
 *
 * @param {object} candidate Candidate carrying a `placements` array.
 * @param {?string} stickyCorner Corner pinned by the label's state, if any.
 * @param {?object} fallback Placement to return when no finite placement exists
 *   — normally the one recorded at selection time, so a label keeps its last
 *   position while its geometry is momentarily unavailable.
 * @returns {?object} Placement to paint this frame.
 */
function renderPlacement(candidate, stickyCorner, fallback) {
  const placements = candidate?.placements;
  if (!Array.isArray(placements)) return fallback;
  let first = null;
  for (let i = 0; i < placements.length; i++) {
    const placement = placements[i];
    if (!rectIsFinite(placement?.rect)) continue;
    first ||= placement;
    if (placement.corner === stickyCorner) return placement;
  }
  return first || fallback;
}

/** Stateful stable label selector shared by Sparse, Balanced, and Dense. */
export class LabelArbiter {
  constructor() {
    this.states = new Map();
    this.selectedKeys = new Set();
    this.solveRevision = 0;
    this.lastDiagnostics = null;
    this.lastActiveLayers = [];
    // Pooled solve working set. Everything here is candidate-scale and is
    // reused across solves so a moving cohort re-solves without churn.
    this._stateList = [];
    this._stateListDirty = true;
    this._candidates = [];
    this._layerBuckets = new Map();
    this._demand = new Map();
    this._quotas = new Map();
    this._weightedQuotaScratch = [];
    this._quotaPriorityScratch = [];
    this._quotaRemainderScratch = [];
    this._activeLayersScratch = [];
    this._selectedCandidates = [];
    this._selectedPlacements = [];
    this._droppedKeys = [];
    this._attemptStamps = new Map();
    this._selectStamps = new Map();
    this._spatial = new SpatialHash();
    this._queue = new SpatialCandidateQueue();
  }

  clear() {
    this.states.clear();
    this.selectedKeys.clear();
    this.solveRevision = 0;
    this.lastDiagnostics = null;
    this.lastActiveLayers = [];
    this._stateList.length = 0;
    this._stateListDirty = true;
    this._candidates.length = 0;
    this._layerBuckets.clear();
    this._quotas.clear();
    this._selectedCandidates.length = 0;
    this._selectedPlacements.length = 0;
    this._droppedKeys.length = 0;
    this._attemptStamps.clear();
    this._selectStamps.clear();
    this._spatial.clear();
  }

  /**
   * Refresh the pooled state list when solve membership has moved on.
   * @returns {Array<object>} The pooled backing array — internal only, never
   *   handed to callers.
   */
  _refreshStateList() {
    if (!this._stateListDirty) return this._stateList;
    const list = this._stateList;
    let index = 0;
    for (const state of this.states.values()) list[index++] = state;
    list.length = index;
    this._stateListDirty = false;
    return list;
  }

  /**
   * Number of live states, for indexed per-frame iteration. Callers must not
   * receive the pooled backing array — a caller that mutated it would desync
   * the arbiter permanently — and must not iterate `states` directly either,
   * because a Map iterator allocates a result object per step.
   * @returns {number} Count of states currently held, selected and fading both.
   */
  activeStateCount() {
    return this._refreshStateList().length;
  }

  /**
   * Live state at `index`, valid for the current solve generation.
   * @param {number} index Position in [0, activeStateCount); out-of-range reads
   *   undefined rather than throwing.
   * @returns {object|undefined} Label state record, or undefined past the end.
   */
  activeStateAt(index) {
    return this._refreshStateList()[index];
  }

  /**
   * Select a bounded, stable label cohort. The selection is byte-for-byte the
   * same as the original list-building implementation; only the working set is
   * pooled, so a moving cohort re-solves without per-candidate allocation.
   *
   * Duplicate keys: attempt and selection membership are tracked per KEY (the
   * stamp maps), exactly as the original `Set`/`Map` did, so two candidate
   * objects sharing one key still get a single attempt and a single slot. The
   * queue spread distances and few-placement masks live in candidate-indexed
   * pooled storage, so duplicates keep independent spatial state — harmless,
   * because only the one that wins the key is ever selected, but callers
   * should keep keys unique per solve.
   *
   * @param {Array<object>} candidates Cohort for this solve; entries lacking a
   *   key, layerId, or positive keyholeAlpha are skipped. Non-arrays are treated
   *   as empty.
   * @param {object} [options] Per-solve knobs; all optional.
   * @param {number} [options.capacity] Total label budget; defaults to 0, which
   *   selects nothing.
   * @param {string} [options.strategy] 'ELASTIC' or 'WEIGHTED' quota split.
   * @param {Map<string, number>|{[key: string]: number}} [options.demandByLayer]
   *   Full lightweight-field demand; layers with candidates but no entry here
   *   fall back to their candidate count.
   * @param {[key: string]: number} [options.layerWeights] Semantic weights for
   *   the weighted strategy.
   * @param {boolean} [options.preserveIncumbents=true] Try sitting winners first
   *   — disabled automatically when the active layer set changed.
   * @param {number} [options.now] Frame timestamp driving fades and cooldowns.
   * @param {boolean} [options.collectDiagnostics=true] Build `lastDiagnostics`;
   *   skipping it saves the per-solve object churn in hot paths.
   * @returns {?object} The diagnostics object when collected, otherwise null —
   *   always a fresh copy-free singleton owned by the arbiter.
   */
  solve(candidates, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const collectDiagnostics = options.collectDiagnostics !== false;
    const stamp = ++_globalSolveStamp;
    const attemptStamps = this._attemptStamps;
    const selectStamps = this._selectStamps;

    const candidateList = this._candidates;
    const source = Array.isArray(candidates) ? candidates : EMPTY_CANDIDATES;
    const byLayer = this._layerBuckets;
    byLayer.forEach(resetLayerBucket);
    let candidateCount = 0;
    for (let i = 0; i < source.length; i++) {
      const candidate = source[i];
      if (!candidate || !candidate.key || !candidate.layerId || !(candidate.keyholeAlpha > 0)) continue;
      cacheCandidateAnchorScalars(candidate);
      candidateList[candidateCount++] = candidate;
      let bucket = byLayer.get(candidate.layerId);
      if (!bucket) {
        bucket = { list: [], count: 0 };
        byLayer.set(candidate.layerId, bucket);
      }
      bucket.list[bucket.count++] = candidate;
    }
    candidateList.length = candidateCount;
    byLayer.forEach((bucket) => {
      bucket.list.length = bucket.count;
      sortCandidateRange(bucket.list, bucket.count, this.states, now);
    });

    const demand = this._demand;
    demand.clear();
    if (options.demandByLayer instanceof Map) {
      options.demandByLayer.forEach((count, layerId) => {
        const normalized = Math.max(0, Math.floor(Number(count) || 0));
        if (normalized > 0) demand.set(String(layerId), normalized);
      });
    } else if (options.demandByLayer != null) {
      const supplied = demandEntries(options.demandByLayer);
      for (let i = 0; i < supplied.length; i++) demand.set(supplied[i][0], supplied[i][1]);
    }
    // A supplied demand map describes the full lightweight field while the
    // candidate list may be only a bounded materialized cohort. Keep defensive
    // support for candidate layers omitted by an incomplete caller map.
    byLayer.forEach((bucket, layerId) => {
      if (bucket.count > 0 && !demand.has(layerId)) demand.set(layerId, bucket.count);
    });

    const activeLayers = this._activeLayersScratch;
    let activeCount = 0;
    let totalDemand = 0;
    demand.forEach((count, layerId) => {
      totalDemand += count;
      activeLayers[activeCount++] = layerId;
    });
    activeLayers.length = activeCount;
    activeLayers.sort();

    const capacity = clampInt(options.capacity, 0, totalDemand);
    const strategy = normalizeAllocationStrategy(options.strategy);
    const quotas = allocateLayerQuotasInto(
      demand,
      capacity,
      strategy,
      options.layerWeights,
      activeLayers,
      activeCount,
      this._quotas,
      this._weightedQuotaScratch,
      this._quotaPriorityScratch,
      this._quotaRemainderScratch,
    );
    const spatial = this._spatial;
    spatial.reset();
    const queue = this._queue;
    const selectedCandidates = this._selectedCandidates;
    const selectedPlacements = this._selectedPlacements;
    let selectedCount = 0;

    let sameActiveLayers = activeCount === this.lastActiveLayers.length;
    for (let i = 0; sameActiveLayers && i < activeCount; i++) {
      if (activeLayers[i] !== this.lastActiveLayers[i]) sameActiveLayers = false;
    }
    const preserveIncumbents = options.preserveIncumbents !== false && sameActiveLayers;
    let spatialQueueBuildCount = 0;
    let spatialQueueNextCount = 0;

    // At high fill rates the spatial hash search spends most of its time
    // finding no free slot. Switching to ordered placement avoids the hash
    // probe overhead once we're close to capacity.
    const DENSE_THRESHOLD = 0.9;
    // Evaluate per-call so selectedCount reflects current fill level.
    const isDense = () => capacity > 0 && selectedCount >= capacity * DENSE_THRESHOLD;

    const attempt = (candidate, allowOverlapFallback = false) => {
      if (selectedCount >= capacity || attemptStamps.get(candidate.key) === stamp) return false;
      attemptStamps.set(candidate.key, stamp);
      const previous = this.states.get(candidate.key);
      const stateless = candidate.stateless === true;
      // Stateless candidates ignore the re-entry cooldown (they return on the
      // very next solve, as their stateless originals did) and carry no sticky
      // corner, so above/below is re-decided from geometry every solve instead
      // of being pinned by whichever side happened to be free once.
      if (!stateless && !previous?.selected && previous?.cooldownUntil > now) return false;
      const sticky = stateless ? undefined : previous?.corner;
      let placement;
      if (isDense()) {
        // Skip the spatial hash search — ordered placement is visually
        // indistinguishable at this density and avoids all hash probe cost.
        placement = firstOrderedPlacement(candidate, sticky);
      } else {
        placement = firstFreePlacement(candidate, sticky, spatial);
        if (!placement && allowOverlapFallback) placement = firstOrderedPlacement(candidate, sticky);
      }
      if (!placement) return false;
      if (!isDense()) spatial.add(placement.rect);
      selectStamps.set(candidate.key, stamp);
      selectedCandidates[selectedCount] = candidate;
      selectedPlacements[selectedCount] = placement;
      selectedCount++;
      return true;
    };

    for (let l = 0; l < activeCount; l++) {
      const layerId = activeLayers[l];
      const target = quotas.get(layerId) || 0;
      const bucket = byLayer.get(layerId);
      const layerList = bucket ? bucket.list : EMPTY_CANDIDATES;
      const layerCount = bucket ? bucket.count : 0;
      let accepted = 0;
      if (preserveIncumbents) {
        for (let i = 0; i < layerCount && accepted < target; i++) {
          const candidate = layerList[i];
          if (!this.states.get(candidate.key)?.selected) continue;
          if (attempt(candidate, true)) accepted++;
        }
      }
      if (accepted < target) {
        spatialQueueBuildCount++;
        queue.reset(
          layerList,
          layerCount,
          selectedCandidates,
          selectedCount,
          attemptStamps,
          stamp,
          spatial,
          this.states,
        );
        while (accepted < target) {
          spatialQueueNextCount++;
          const candidate = queue.next(attemptStamps, stamp);
          if (!candidate) break;
          if (attempt(candidate)) {
            accepted++;
            queue.addAnchor(candidate, selectedPlacements[selectedCount - 1]);
          }
        }
      }
    }

    if (selectedCount < capacity) {
      spatialQueueBuildCount++;
      queue.reset(
        candidateList,
        candidateCount,
        selectedCandidates,
        selectedCount,
        attemptStamps,
        stamp,
        spatial,
        this.states,
      );
      while (selectedCount < capacity) {
        spatialQueueNextCount++;
        const candidate = queue.next(attemptStamps, stamp);
        if (!candidate) break;
        if (attempt(candidate)) {
          queue.addAnchor(candidate, selectedPlacements[selectedCount - 1]);
        }
      }
    }

    // `selectedKeys` still holds the previous solve's winners here, so both
    // incumbent tallies are read before it is updated in place.
    let eligibleIncumbents = 0;
    for (let i = 0; i < candidateCount; i++) {
      if (this.selectedKeys.has(candidateList[i].key)) eligibleIncumbents++;
    }
    let retainedIncumbents = 0;
    for (let i = 0; i < selectedCount; i++) {
      if (this.selectedKeys.has(selectedCandidates[i].key)) retainedIncumbents++;
    }

    const exitingStates = this._refreshStateList();
    for (let i = 0; i < exitingStates.length; i++) {
      const state = exitingStates[i];
      if (state.selected && selectStamps.get(state.key) !== stamp) {
        state.selected = false;
        state.exitStartedAt = now;
        // Stateless entries may be re-selected immediately; the cooldown exists
        // to damp thrash for sources that shipped with hysteresis.
        state.cooldownUntil = state.stateless ? 0 : now + FADE_OUT_MS + COOLDOWN_MS;
      }
    }

    const labelsByLayer = collectDiagnostics ? {} : null;
    for (let i = 0; i < selectedCount; i++) {
      const candidate = selectedCandidates[i];
      const placement = selectedPlacements[i];
      const key = candidate.key;
      const previous = this.states.get(key);
      const state = previous || {
        key,
        selected: false,
        selectedAt: now,
        enterStartedAt: now,
        exitStartedAt: null,
        cooldownUntil: 0,
        corner: undefined,
        stateless: false,
        lastCandidate: null,
        lastPlacement: null,
      };
      if (!state.selected) {
        state.selectedAt = now;
        state.enterStartedAt = now;
      }
      state.selected = true;
      state.exitStartedAt = null;
      state.cooldownUntil = 0;
      state.corner = placement.corner;
      state.stateless = candidate.stateless === true;
      state.lastCandidate = candidate;
      state.lastPlacement = placement;
      if (!previous) {
        this.states.set(key, state);
        this._stateListDirty = true;
      }
      if (labelsByLayer) {
        labelsByLayer[candidate.layerId] = (labelsByLayer[candidate.layerId] || 0) + 1;
      }
    }

    for (let i = 0; i < candidateCount; i++) {
      const state = this.states.get(candidateList[i].key);
      if (state) state.lastCandidate = candidateList[i];
    }
    const livingStates = this._refreshStateList();
    for (let i = 0; i < livingStates.length; i++) {
      const state = livingStates[i];
      if (!state.selected && now - (state.exitStartedAt || now) > FADE_OUT_MS + COOLDOWN_MS) {
        this.states.delete(state.key);
        this._stateListDirty = true;
      }
    }

    const dropped = this._droppedKeys;
    let droppedCount = 0;
    this.selectedKeys.forEach((key) => {
      if (selectStamps.get(key) !== stamp) dropped[droppedCount++] = key;
    });
    for (let i = 0; i < droppedCount; i++) this.selectedKeys.delete(dropped[i]);
    dropped.length = droppedCount;
    for (let i = 0; i < selectedCount; i++) this.selectedKeys.add(selectedCandidates[i].key);

    const previousActiveLayers = this.lastActiveLayers;
    this.lastActiveLayers = activeLayers;
    this._activeLayersScratch = previousActiveLayers;
    this.solveRevision++;
    this.lastDiagnostics = collectDiagnostics ? {
      strategy,
      capacity,
      selectedCount,
      quotas: Object.fromEntries(quotas),
      demand: Object.fromEntries(demand),
      labelsByLayer,
      solveRevision: this.solveRevision,
      spatialQueueBuildCount,
      spatialQueueNextCount,
      eligibleIncumbents,
      retainedIncumbents,
    } : null;
    selectedCandidates.length = selectedCount;
    selectedPlacements.length = selectedCount;
    pruneStampMap(attemptStamps, candidateCount);
    pruneStampMap(selectStamps, candidateCount);
    return this.lastDiagnostics;
  }

  /**
   * Reproject accepted/fading identities from the current frame candidate map.
   * A caller-owned output array enables allocation-free per-frame rendering.
   *
   * @param {Map<string,object>|Array<object>} currentCandidates This frame's
   *   candidates keyed by label key; an array is keyed up on entry. Entries
   *   absent here fall back to the state's last seen candidate.
   * @param {number} [now] Frame timestamp driving enter/exit fade progress.
   * @param {Array<object>} [out] Caller-owned output array, reused and
   *   truncated to the returned length.
   * @returns {Array<object>} The same `out`, up to one entry per live state
   *   with non-zero alpha, each carrying `candidate`, `placement`,
   *   `temporalAlpha` and `selected`.
   */
  renderEntries(currentCandidates, now = Date.now(), out = []) {
    const current = currentCandidates instanceof Map
      ? currentCandidates
      : new Map((currentCandidates || []).map((candidate) => [candidate.key, candidate]));
    const states = this._refreshStateList();
    let outIndex = 0;
    for (let i = 0; i < states.length; i++) {
      const state = states[i];
      let temporalAlpha;
      if (state.stateless) {
        // Hard cliffs, matching a per-frame rebuild: a stateless entry is either
        // fully painted this solve or gone. No enter ramp, no exit tail.
        temporalAlpha = state.selected ? 1 : 0;
      } else if (state.selected) {
        temporalAlpha = Math.min(1, Math.max(0, (now - state.enterStartedAt) / FADE_IN_MS));
      } else {
        temporalAlpha = 1 - Math.min(1, Math.max(0, (now - state.exitStartedAt) / FADE_OUT_MS));
      }
      if (temporalAlpha <= 0) continue;
      const candidate = current.get(state.key) || state.lastCandidate;
      if (!candidate) continue;
      const placement = renderPlacement(candidate, state.stateless ? undefined : state.corner, state.lastPlacement);
      if (!placement) continue;
      const entry = out[outIndex] || (out[outIndex] = {});
      entry.candidate = candidate;
      entry.placement = placement;
      entry.temporalAlpha = temporalAlpha;
      entry.selected = state.selected;
      outIndex++;
    }
    out.length = outIndex;
    return out;
  }

  /**
   * Return the bounded identities that still need per-frame placement data.
   * The grouped layer/source representation lets the render lane test live
   * membership without allocating composite keys for every losing source.
   *
   * @param {object} [root0] Selection knobs.
   * @param {boolean} [root0.includeFading=true] Also return identities on their
   *   way out, whose labels are still painted this frame.
   * @param {number} [root0.now] Frame timestamp the fade-out window is measured
   *   against.
   * @returns {Map<string, Set<*>>} layerId→set of sourceIds still needing
   *   placement data.
   */
  liveIdentities({ includeFading = true, now = Date.now() } = {}) {
    const grouped = new Map();
    for (const state of this.states.values()) {
      if (!state.selected) {
        if (!includeFading) continue;
        if (!Number.isFinite(state.exitStartedAt) || now - state.exitStartedAt >= FADE_OUT_MS) continue;
      }
      const candidate = state.lastCandidate;
      if (!candidate?.layerId || candidate.sourceId == null) continue;
      if (!grouped.has(candidate.layerId)) grouped.set(candidate.layerId, new Set());
      grouped.get(candidate.layerId).add(candidate.sourceId);
    }
    return grouped;
  }

  diagnostics() {
    return this.lastDiagnostics ? { ...this.lastDiagnostics } : null;
  }
}

export const LABEL_ARBITER_TIMING = Object.freeze({
  fadeInMs: FADE_IN_MS,
  fadeOutMs: FADE_OUT_MS,
  minimumLifetimeMs: MIN_LIFETIME_MS,
  cooldownMs: COOLDOWN_MS,
});

export { ALLOCATION_ELASTIC, ALLOCATION_WEIGHTED };
