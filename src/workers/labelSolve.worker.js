/**
 * LabelArbiter Solve Worker
 *
 * Offloads the O(n log n) label placement solve to a Web Worker.
 * The main thread sends candidates + options; the worker returns selected keys.
 *
 * The worker implements a pure version of the placement algorithm:
 * - Layer quota allocation (elastic or weighted)
 * - Spatial hash + ordered placement
 * - Sticky incumbent preservation
 *
 * Input message: {
 *   candidates: Array<{key, layerId, keyholeAlpha, stateless, x, y, w, h, priority?}>,
 *   options: {
 *     capacity: number,
 *     strategy: 'ELASTIC' | 'WEIGHTED',
 *     layerWeights: Object<string, number>,
 *     demandByLayer: Object<string, number>,
 *     now: number,
 *     preserveIncumbents: boolean,
 *     selectedKeys: Set<string>  — previous solve winners for incumbent preservation
 *   },
 *   requestId: number
 * }
 *
 * Output message: {
 *   selectedKeys: string[],  — keys of winning candidates
 *   diagnostics: { candidateCount, selectedCount, spatialBuilds, spatialSearches },
 *   requestId: number
 * }
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const CELL_SIZE_PX = 32;
const DENSE_THRESHOLD = 0.9;
const COOLDOWN_MS = 1200;
const FADE_IN_MS = 150;

// ─── Spatial hash ─────────────────────────────────────────────────────────────

function makeSpatial() {
  const cells = new Map();
  return {
    reset() { cells.clear(); },
    add(rect) {
      const minX = Math.floor(rect.x / CELL_SIZE_PX);
      const minY = Math.floor(rect.y / CELL_SIZE_PX);
      const maxX = Math.floor((rect.x + rect.w - 1) / CELL_SIZE_PX);
      const maxY = Math.floor((rect.y + rect.h - 1) / CELL_SIZE_PX);
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cy = minY; cy <= maxY; cy++) {
          const key = (cx & 0xFFFF) | ((cy & 0xFFFF) << 16);
          let cell = cells.get(key);
          if (!cell) { cell = []; cells.set(key, cell); }
          cell.push(rect);
        }
      }
    },
    /**
     * @param {number} x @param {number} y @param {number} w @param {number} h
     * @returns {boolean} true if the rect overlaps no cell entry
     */
    isFree(x, y, w, h) {
      const minX = Math.floor(x / CELL_SIZE_PX);
      const minY = Math.floor(y / CELL_SIZE_PX);
      const maxX = Math.floor((x + w - 1) / CELL_SIZE_PX);
      const maxY = Math.floor((y + h - 1) / CELL_SIZE_PX);
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cy = minY; cy <= maxY; cy++) {
          const key = (cx & 0xFFFF) | ((cy & 0xFFFF) << 16);
          const cell = cells.get(key);
          if (!cell) continue;
          for (const r of cell) {
            if (rectsOverlap(x, y, w, h, r.x, r.y, r.w, r.h)) return false;
          }
        }
      }
      return true;
    },
  };
}

function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// ─── Ordered placement ─────────────────────────────────────────────────────────

function firstOrderedPlacement(candidate, sticky) {
  const { x, y, w, h } = candidate;
  const corners = [
    { corner: 'NE', px: x + w, py: y },
    { corner: 'NW', px: x - w, py: y },
    { corner: 'SE', px: x + w, py: y + h },
    { corner: 'SW', px: x - w, py: y + h },
    { corner: 'E', px: x + w, py },
    { corner: 'W', px: x - w, py: y + h / 2 },
    { corner: 'N', px: x + w / 2, py: y },
    { corner: 'S', px: x + w / 2, py: y + h },
    { corner: 'C', px, py: y + h / 2 }, // centered fallback
  ];
  const useCorner = sticky ?? corners[0].corner;
  const idx = corners.findIndex(c => c.corner === useCorner);
  const ordered = [...corners.slice(idx), ...corners.slice(0, idx)];
  for (const c of ordered) {
    const rx = c.px - w / 2;
    const ry = c.py - h / 2;
    if (rx >= 0 && ry >= 0) return { corner: c.corner, rect: { x: rx, y: ry, w, h } };
  }
  return { corner: useCorner, rect: { x, y: y + h / 2, w, h } };
}

// ─── Allocation ────────────────────────────────────────────────────────────────

function allocateQuotas(demand, capacity, strategy, layerWeights, ids) {
  const n = ids.length;
  const quotas = new Map();
  if (capacity === 0 || n === 0) return quotas;

  if (strategy === 'ELASTIC') {
    const base = Math.floor(capacity / n);
    let remainder = capacity % n;
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      const entitlement = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      quotas.set(id, Math.min(demand.get(id) || 0, entitlement));
    }
  } else {
    // WEIGHTED
    let totalWeight = 0;
    for (const id of ids) totalWeight += layerWeights?.[id] ?? 1;
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      const weight = (layerWeights?.[id] ?? 1) / totalWeight;
      quotas.set(id, Math.floor((capacity * weight)));
    }
  }

  // Fill unused slots
  let used = 0;
  quotas.forEach(v => { used += v; });
  while (used < capacity) {
    let changed = false;
    for (const id of ids) {
      if ((quotas.get(id) || 0) < (demand.get(id) || 0)) {
        quotas.set(id, (quotas.get(id) || 0) + 1);
        used++;
        changed = true;
        if (used >= capacity) break;
      }
    }
    if (!changed) break;
  }
  return quotas;
}

// ─── Main solve ───────────────────────────────────────────────────────────────

function solveLabels(candidates, options, selectedKeysSet) {
  const {
    capacity,
    strategy = 'ELASTIC',
    layerWeights = {},
    demandByLayer = {},
    now = Date.now(),
    preserveIncumbents = true,
  } = options;

  const stamp = (Math.random() * 0xFFFFFF) | 0;
  const spatial = makeSpatial();

  // Filter and group by layer
  const byLayer = new Map();
  const layerIds = [];
  let totalDemand = 0;
  for (const [layerId, demand] of Object.entries(demandByLayer)) {
    if (demand > 0) {
      totalDemand += demand;
      layerIds.push(layerId);
      byLayer.set(layerId, []);
    }
  }
  layerIds.sort();

  const valid = [];
  for (const c of candidates) {
    if (!c || !c.key || !c.layerId || !(c.keyholeAlpha > 0)) continue;
    valid.push(c);
    const bucket = byLayer.get(c.layerId);
    if (bucket) bucket.push(c);
  }

  const actualCapacity = Math.min(capacity, totalDemand);
  const quotas = allocateQuotas(new Map(Object.entries(demandByLayer)), actualCapacity, strategy, layerWeights, layerIds);

  const selected = [];
  const selectedKeys = new Set();

  // ── Per-layer pass ────────────────────────────────────────────────────────
  for (const layerId of layerIds) {
    const target = quotas.get(layerId) || 0;
    if (target === 0) continue;
    const bucket = byLayer.get(layerId) || [];
    let accepted = 0;

    // Incumbent pass: try to keep previous winners
    if (preserveIncumbents && selectedKeysSet) {
      for (const c of bucket) {
        if (accepted >= target) break;
        if (selectedKeysSet.has(c.key)) {
          const placement = firstOrderedPlacement(c, null);
          selected.push({ key: c.key, placement });
          selectedKeys.add(c.key);
          spatial.add(placement.rect);
          accepted++;
        }
      }
    }

    // Greedy pass: fill remaining slots
    for (const c of bucket) {
      if (accepted >= target) break;
      if (selectedKeys.has(c.key)) continue;
      const placement = firstOrderedPlacement(c, null);
      selected.push({ key: c.key, placement });
      selectedKeys.add(c.key);
      spatial.add(placement.rect);
      accepted++;
    }
  }

  // ── Any remaining capacity: cross-layer fill ───────────────────────────────
  if (selected.length < actualCapacity) {
    const remaining = valid.filter(c => !selectedKeys.has(c.key));
    // Sort by priority descending (higher = more important)
    remaining.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    while (selected.length < actualCapacity && remaining.length > 0) {
      const c = remaining.shift();
      const placement = firstOrderedPlacement(c, null);
      selected.push({ key: c.key, placement });
      selectedKeys.add(c.key);
      spatial.add(placement.rect);
    }
  }

  return {
    selectedKeys: Array.from(selectedKeys),
    diagnostics: {
      candidateCount: valid.length,
      selectedCount: selected.length,
    },
  };
}

// ─── Worker message handler ───────────────────────────────────────────────────

self.onmessage = (e) => {
  const { candidates, options, requestId } = e.data;
  const selectedKeysSet = options.selectedKeys
    ? new Set(Array.isArray(options.selectedKeys) ? options.selectedKeys : [])
    : new Set();

  const result = solveLabels(candidates, options, selectedKeysSet);
  self.postMessage({ ...result, requestId });
};
