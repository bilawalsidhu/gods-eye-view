// src/data/localGeojsonLod.js
/**
 * @module localGeojsonLod
 *
 * Pure selection policy for the bundled local-infrastructure layers
 * (`local-datacenters`, `local-dams`, and any future `createLocalGeoJsonLayer`
 * dataset). Cesium-specific projection, occlusion, and stem geometry stay in
 * `localGeojson.js`; this module turns the resulting in-view records into a
 * bounded "active" set — the only records that layer should spend per-frame
 * stem-geometry and ground-sample work on.
 *
 * Why this exists: `createLocalGeoJsonLayer` currently materializes and walks
 * EVERY feature (~700 datacenters + ~900 dams + submarine cables ≈ 5,700
 * entities) on every pre-render pass and every camera move. The screen-space
 * label overlay is already decluttered (LOCAL_OVERLAY_COHORT_LIMIT); the
 * world-space stems are not. On a full-earth view that is the frame-rate
 * cliff that got the INFRASTRUCTURE first-run tile cut
 * (see docs/CURRENT-STATE.md, docs/KNOWN-ISSUES.md).
 *
 * Sense is INVERTED relative to `cctvLod.js`: a CCTV metro view earns MORE
 * cards, but a zoomed-out infrastructure view must show FEWER stems — that is
 * exactly the view where every feature piles onto the screen at once. Zoom in
 * and the in-view count falls naturally, so the budget opens back up.
 *
 * The engine keeps three concerns, all pure and individually testable:
 *   - BUDGET: camera height → how many stems may be active.
 *   - RANK: importance (the existing label-priority score) blended with a
 *     bounded proximity penalty, plus an incumbency bonus so the active set
 *     does not batch-swap on small camera moves.
 *   - EVICTION GRACE: a hysteresis planner (ported from cctvLod) so a stem at
 *     the budget edge does not blink in and out while the camera orbits.
 */

/* ------------------------------------------------------------------ *
 * BUDGET
 * ------------------------------------------------------------------ */

/** Active-stem budget at full-earth / global framing — the hot case. */
export const INFRA_LOD_ACTIVE_MIN = 80;
/** Active-stem budget at continental framing. */
export const INFRA_LOD_ACTIVE_MID = 200;
/** Active-stem budget at regional framing and closer (effectively "all in view"). */
export const INFRA_LOD_ACTIVE_MAX = 420;

/** At or above this camera height (m) the view is global: clamp hardest. */
export const INFRA_LOD_GLOBAL_HEIGHT_M = 3_000_000;
/** At or above this camera height (m) the view is continental. */
export const INFRA_LOD_REGIONAL_HEIGHT_M = 200_000;

/**
 * Bounded active-stem budget for the current camera height. Non-finite input
 * resolves to the GLOBAL band (fewest stems) — the safe default for a value we
 * could not read is the cheapest one, not the most expensive.
 *
 * @param {number} cameraHeightM
 * @returns {{activeLimit:number}}
 */
export function infraLodBudget(cameraHeightM) {
  const height = Number.isFinite(cameraHeightM)
    ? Math.max(0, cameraHeightM)
    : INFRA_LOD_GLOBAL_HEIGHT_M;
  if (height >= INFRA_LOD_GLOBAL_HEIGHT_M) return { activeLimit: INFRA_LOD_ACTIVE_MIN };
  if (height >= INFRA_LOD_REGIONAL_HEIGHT_M) return { activeLimit: INFRA_LOD_ACTIVE_MID };
  return { activeLimit: INFRA_LOD_ACTIVE_MAX };
}

/* ------------------------------------------------------------------ *
 * RANK
 * ------------------------------------------------------------------ */

/**
 * Priority points added for a record that currently holds an active stem, so a
 * non-incumbent displaces it only when meaningfully better — not on sub-pixel
 * camera jitter. Deliberately smaller than the label-priority "has a name"
 * gap (≥700 in labelPriorityFromProperties), so incumbency reorders WITHIN a
 * tier but never keeps an unnamed stem alive over a fresh named feature.
 */
export const INFRA_LOD_INCUMBENT_BONUS = 250;

/**
 * Distance at or beyond which the proximity penalty is fully applied (m).
 * Matches LOCAL_OVERLAY_MAX_DISTANCE_M's order of magnitude in localGeojson.js.
 */
export const INFRA_LOD_FAR_M = 12_000_000;

/**
 * Maximum priority points subtracted for distance. Capped well below the
 * label-priority name gap on purpose: proximity breaks ties among
 * similarly-important features (show the near named dam before the far named
 * dam) but can never promote an unnamed node over a named one.
 */
export const INFRA_LOD_MAX_DISTANCE_PENALTY = 200;

/**
 * Keep-score for one record. Higher wins. Pure; no clamping of the result
 * (callers only compare it), but every input is normalized so the output is
 * always a finite number.
 *
 * @param {number} priority Existing label-priority score (localGeojson.js).
 * @param {number} distanceM Camera→feature distance in metres.
 * @param {boolean} isIncumbent Record currently holds an active stem.
 * @param {object} [options]
 * @param {number} [options.incumbentBonus]
 * @param {number} [options.farM]
 * @param {number} [options.maxDistancePenalty]
 * @returns {number}
 */
export function infraRankScore(priority, distanceM, isIncumbent, {
  incumbentBonus = INFRA_LOD_INCUMBENT_BONUS,
  farM = INFRA_LOD_FAR_M,
  maxDistancePenalty = INFRA_LOD_MAX_DISTANCE_PENALTY,
} = {}) {
  const p = Number.isFinite(priority) ? priority : 0;
  const far = Number.isFinite(farM) && farM > 0 ? farM : INFRA_LOD_FAR_M;
  const d = Number.isFinite(distanceM) && distanceM >= 0 ? distanceM : far;
  const penaltyCap = Number.isFinite(maxDistancePenalty) && maxDistancePenalty >= 0
    ? maxDistancePenalty
    : INFRA_LOD_MAX_DISTANCE_PENALTY;
  const bonus = isIncumbent && Number.isFinite(incumbentBonus) ? incumbentBonus : 0;
  return p + bonus - penaltyCap * Math.min(1, d / far);
}

/** Infinity-safe distance for a total sort order. */
function sortableDistance(distanceM) {
  return Number.isFinite(distanceM) && distanceM >= 0 ? distanceM : Number.MAX_VALUE;
}

/**
 * Select the active-stem set from already projected in-view candidates.
 *
 * A candidate is `{ id, priority, distanceM, inView }`. Only `inView === true`
 * candidates are eligible — the caller runs the (cheap) ellipsoidal-occluder
 * test for every record and hands the result here; this module then decides
 * which of those get the (expensive) stem geometry + ground-sample work.
 *
 * Ranking: `infraRankScore` descending, then nearer first, then id — a total
 * order, so an under-budget cut is deterministic. Duplicate ids collapse to
 * their best-scoring representative before the cut.
 *
 * @param {Array<{id:string,priority?:number,distanceM?:number,inView?:boolean}>} candidates
 * @param {object} [options]
 * @param {number} [options.cameraHeightM]
 * @param {Iterable<string>|Set<string>} [options.incumbentIds] Ids that currently hold an active stem.
 * @returns {{activeIds:string[], budget:{activeLimit:number}}}
 */
export function selectInfraLod(candidates, { cameraHeightM, incumbentIds } = {}) {
  const budget = infraLodBudget(cameraHeightM);
  const incumbents = incumbentIds instanceof Set ? incumbentIds : new Set(incumbentIds || []);

  const byId = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id) continue;
    if (candidate.inView !== true) continue;
    const distanceM = Number.isFinite(candidate.distanceM) && candidate.distanceM >= 0
      ? candidate.distanceM
      : Number.POSITIVE_INFINITY;
    const normalized = {
      id: candidate.id,
      distanceM,
      score: infraRankScore(candidate.priority, candidate.distanceM, incumbents.has(candidate.id)),
    };
    const current = byId.get(normalized.id);
    if (!current
      || normalized.score > current.score
      || (normalized.score === current.score && normalized.distanceM < current.distanceM)) {
      byId.set(normalized.id, normalized);
    }
  }

  const ranked = [...byId.values()].sort((a, b) => (
    b.score - a.score
    || sortableDistance(a.distanceM) - sortableDistance(b.distanceM)
    || a.id.localeCompare(b.id)
  ));

  return {
    activeIds: ranked.slice(0, budget.activeLimit).map((entry) => entry.id),
    budget,
  };
}

/* ------------------------------------------------------------------ *
 * EVICTION GRACE
 * ------------------------------------------------------------------ */

export const INFRA_LOD_GRACE_PASSES = 2;
export const INFRA_LOD_GRACE_MS = 4_000;

/**
 * Eviction-grace hysteresis for the active-stem set. Ported from
 * cctvLod.applyEvictionGrace — same algorithm, infra-tuned constants.
 *
 * Raw per-pass selection has no memory: a stem sitting at the budget edge
 * churns in and out on every small camera move. This planner keeps an
 * already-built stem alive for a short grace window after it falls out of the
 * selection — dropped only once it STAYS unselected for `gracePasses`
 * consecutive passes or `graceMs` of wall time, whichever comes first. A newly
 * selected record enters immediately; the hard `activeLimit` cap is never
 * exceeded (grace-period stems are evicted first under cap pressure,
 * oldest-in-grace first).
 *
 * Pure: `graceState` is never mutated; the returned `graceState` replaces it.
 *
 * @param {object} [input]
 * @param {string[]} [input.selectedIds] This pass's selection (already capped).
 * @param {string[]} [input.builtIds] Ids that currently have a live stem.
 * @param {Map<string,{misses:number,since:number}>} [input.graceState]
 * @param {number} [input.nowMs]
 * @param {number} [input.activeLimit] Hard cap on total kept stems.
 * @param {number} [input.gracePasses]
 * @param {number} [input.graceMs]
 * @returns {{keepIds:string[], evictIds:string[], graceState:Map<string,{misses:number,since:number}>}}
 */
export function applyInfraEvictionGrace({
  selectedIds = [],
  builtIds = [],
  graceState = new Map(),
  nowMs = 0,
  activeLimit = INFRA_LOD_ACTIVE_MAX,
  gracePasses = INFRA_LOD_GRACE_PASSES,
  graceMs = INFRA_LOD_GRACE_MS,
} = {}) {
  const selectedSet = new Set(
    (Array.isArray(selectedIds) ? selectedIds : []).filter((id) => typeof id === 'string' && id),
  );
  const keepIds = [...selectedSet];
  const evictIds = [];
  const nextGrace = new Map();

  const graced = [];
  for (const id of Array.isArray(builtIds) ? builtIds : []) {
    if (typeof id !== 'string' || !id || selectedSet.has(id)) continue;
    const prior = graceState instanceof Map ? graceState.get(id) : undefined;
    const misses = (prior?.misses || 0) + 1;
    const since = Number.isFinite(prior?.since) ? prior.since : nowMs;
    if (misses > gracePasses || nowMs - since >= graceMs) {
      evictIds.push(id);
    } else {
      graced.push({ id, misses, since });
    }
  }

  // Under cap pressure, grace-period stems go first: oldest-in-grace first
  // (longest chance to return), then more misses, then id for determinism.
  graced.sort((a, b) => a.since - b.since || b.misses - a.misses || a.id.localeCompare(b.id));
  const cap = Number.isFinite(activeLimit) ? Math.max(0, Math.floor(activeLimit)) : INFRA_LOD_ACTIVE_MAX;
  const capacity = Math.max(0, cap - keepIds.length);
  const overflow = Math.max(0, graced.length - capacity);
  for (let i = 0; i < graced.length; i++) {
    if (i < overflow) {
      evictIds.push(graced[i].id);
      continue;
    }
    keepIds.push(graced[i].id);
    nextGrace.set(graced[i].id, { misses: graced[i].misses, since: graced[i].since });
  }

  return { keepIds, evictIds, graceState: nextGrace };
}
