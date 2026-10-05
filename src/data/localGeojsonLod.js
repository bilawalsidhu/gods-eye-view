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
 * The screen-space label overlay is already decluttered
 * (LOCAL_OVERLAY_COHORT_LIMIT); this also bounds world-space stems and their
 * geometry/ground-sampling work. It does not reduce the number of materialized
 * entities. Submarine cables use their own renderer and are not changed here.
 * Performance must be measured against the current renderer, not inferred
 * from the number of hidden stems.
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
  if (height >= INFRA_LOD_GLOBAL_HEIGHT_M)
    return { activeLimit: INFRA_LOD_ACTIVE_MIN };
  if (height >= INFRA_LOD_REGIONAL_HEIGHT_M)
    return { activeLimit: INFRA_LOD_ACTIVE_MID };
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
export function infraRankScore(
  priority,
  distanceM,
  isIncumbent,
  {
    incumbentBonus = INFRA_LOD_INCUMBENT_BONUS,
    farM = INFRA_LOD_FAR_M,
    maxDistancePenalty = INFRA_LOD_MAX_DISTANCE_PENALTY,
  } = {},
) {
  const p = Number.isFinite(priority) ? priority : 0;
  const far = Number.isFinite(farM) && farM > 0 ? farM : INFRA_LOD_FAR_M;
  const d = Number.isFinite(distanceM) && distanceM >= 0 ? distanceM : far;
  const penaltyCap =
    Number.isFinite(maxDistancePenalty) && maxDistancePenalty >= 0
      ? maxDistancePenalty
      : INFRA_LOD_MAX_DISTANCE_PENALTY;
  const bonus =
    isIncumbent && Number.isFinite(incumbentBonus) ? incumbentBonus : 0;
  return p + bonus - penaltyCap * Math.min(1, d / far);
}

/** Infinity-safe distance for a total sort order. */
function sortableDistance(distanceM) {
  return Number.isFinite(distanceM) && distanceM >= 0
    ? distanceM
    : Number.MAX_VALUE;
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
export function selectInfraLod(
  candidates,
  { cameraHeightM, incumbentIds } = {},
) {
  const budget = infraLodBudget(cameraHeightM);
  const incumbents =
    incumbentIds instanceof Set ? incumbentIds : new Set(incumbentIds || []);

  const byId = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id)
      continue;
    if (candidate.inView !== true) continue;
    const distanceM =
      Number.isFinite(candidate.distanceM) && candidate.distanceM >= 0
        ? candidate.distanceM
        : Number.POSITIVE_INFINITY;
    const normalized = {
      id: candidate.id,
      distanceM,
      score: infraRankScore(
        candidate.priority,
        candidate.distanceM,
        incumbents.has(candidate.id),
      ),
    };
    const current = byId.get(normalized.id);
    if (
      !current ||
      normalized.score > current.score ||
      (normalized.score === current.score &&
        normalized.distanceM < current.distanceM)
    ) {
      byId.set(normalized.id, normalized);
    }
  }

  const ranked = [...byId.values()].sort(
    (a, b) =>
      b.score - a.score ||
      sortableDistance(a.distanceM) - sortableDistance(b.distanceM) ||
      a.id.localeCompare(b.id),
  );

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
    (Array.isArray(selectedIds) ? selectedIds : []).filter(
      (id) => typeof id === 'string' && id,
    ),
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
  graced.sort(
    (a, b) =>
      a.since - b.since || b.misses - a.misses || a.id.localeCompare(b.id),
  );
  const cap = Number.isFinite(activeLimit)
    ? Math.max(0, Math.floor(activeLimit))
    : INFRA_LOD_ACTIVE_MAX;
  const capacity = Math.max(0, cap - keepIds.length);
  const overflow = Math.max(0, graced.length - capacity);
  for (let i = 0; i < graced.length; i++) {
    if (i < overflow) {
      evictIds.push(graced[i].id);
      continue;
    }
    keepIds.push(graced[i].id);
    nextGrace.set(graced[i].id, {
      misses: graced[i].misses,
      since: graced[i].since,
    });
  }

  return { keepIds, evictIds, graceState: nextGrace };
}

/* ------------------------------------------------------------------ *
 * MOTION FALLBACK
 * ------------------------------------------------------------------ */

/**
 * Probe window for the motion fallback. `localGeojson.js` marks its selection
 * dirty on `moveEnd`, which covers drags, one-shot `setView`, and voice
 * `flyTo` — but a tracked-entity follow camera, a Cockpit view, a route
 * flight, or a continuous orbit never emits one. Without a fallback the
 * active set stays pinned to the region the camera left: the walk hides those
 * records one by one as they rotate behind the globe and admits nothing newly
 * visible, so the layer bleeds down to sparse-or-empty until motion stops.
 *
 * The fallback therefore samples camera travel at most this often. Shorter
 * than the cable layer's 2 s window because the walk that consumes it already
 * runs on a 450 ms cadence and the work it re-triggers is bounded by the
 * budget above; longer than that cadence so continuous motion recomputes on a
 * fixed clock rather than on every walk.
 */
export const INFRA_LOD_MOTION_PROBE_INTERVAL_MS = 1_000;

/**
 * Camera travel that counts as material motion, as a fraction of camera
 * height. Scale-relative rather than absolute because the selection is a
 * function of what the globe shows: 500 m of travel re-frames a city view
 * completely and is invisible from 3,000 km up.
 */
export const INFRA_LOD_MOTION_EPSILON_RATIO = 0.02;

/**
 * Floor for that epsilon (m), so a camera near the surface still needs real
 * travel to spend a recompute. Matches the cable layer's flat
 * CABLE_SWEEP_MOTION_EPSILON_M.
 */
export const INFRA_LOD_MOTION_EPSILON_MIN_M = 250;

/**
 * Camera travel that counts as material motion at this camera height.
 *
 * An unreadable height resolves to the FLOOR — the most eager epsilon. That is
 * the opposite polarity to `infraLodBudget`, deliberately: there, a height we
 * could not read must not buy the most expensive band; here, a missed
 * recompute empties the layer while a surplus one costs a single bounded pass.
 *
 * @param {number} cameraHeightM
 * @param {object} [options]
 * @param {number} [options.ratio]
 * @param {number} [options.minM]
 * @returns {number}
 */
export function infraLodMotionEpsilonM(
  cameraHeightM,
  {
    ratio = INFRA_LOD_MOTION_EPSILON_RATIO,
    minM = INFRA_LOD_MOTION_EPSILON_MIN_M,
  } = {},
) {
  const floor =
    Number.isFinite(minM) && minM >= 0 ? minM : INFRA_LOD_MOTION_EPSILON_MIN_M;
  const scale =
    Number.isFinite(ratio) && ratio >= 0
      ? ratio
      : INFRA_LOD_MOTION_EPSILON_RATIO;
  const height =
    Number.isFinite(cameraHeightM) && cameraHeightM > 0 ? cameraHeightM : 0;
  return Math.max(floor, height * scale);
}

/**
 * Should the layer re-run its LOD selection on this pass? Pure: the caller
 * owns `lastProbeMs` and the camera position the last selection ran from, and
 * writes the returned `lastProbeMs` back.
 *
 * Two conditions, both required:
 *   - the probe window has elapsed — the rate limit, so continuous motion
 *     cannot recompute on every walk;
 *   - the camera has travelled past the height-scaled epsilon SINCE THE LAST
 *     SELECTION, not since the previous walk. A parked camera therefore costs
 *     zero recomputes and sub-epsilon jitter never accumulates into one, while
 *     genuine slow travel eventually does.
 *
 * The window re-arms whenever it opens, whether or not it recomputes, so a
 * creeping camera probes on a fixed cadence instead of on every walk.
 *
 * Travel arrives SQUARED so the caller can hand over
 * `Cesium.Cartesian3.distanceSquared` and spend no sqrt on a per-walk probe,
 * the same trade `createCableReferenceSweepGate` makes.
 *
 * @param {object} [input]
 * @param {number} [input.nowMs]
 * @param {number} [input.lastProbeMs] When the window last opened, or the last selection ran.
 * @param {number} [input.movedSqM] Squared camera travel (m²) since the last selection.
 * @param {number} [input.cameraHeightM] Current height — a near camera earns a tighter epsilon.
 * @param {number} [input.probeIntervalMs]
 * @param {number} [input.motionEpsilonM] Explicit epsilon (m); overrides the height scale.
 * @returns {{recompute:boolean, lastProbeMs:number}}
 */
export function shouldRecomputeInfraLod({
  nowMs = 0,
  lastProbeMs = Number.NEGATIVE_INFINITY,
  movedSqM = 0,
  cameraHeightM,
  probeIntervalMs = INFRA_LOD_MOTION_PROBE_INTERVAL_MS,
  motionEpsilonM,
} = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  const last = Number.isFinite(lastProbeMs)
    ? lastProbeMs
    : Number.NEGATIVE_INFINITY;
  const interval =
    Number.isFinite(probeIntervalMs) && probeIntervalMs >= 0
      ? probeIntervalMs
      : INFRA_LOD_MOTION_PROBE_INTERVAL_MS;
  if (now - last < interval) return { recompute: false, lastProbeMs: last };

  const movedSq = Number.isFinite(movedSqM) && movedSqM > 0 ? movedSqM : 0;
  const epsilon =
    Number.isFinite(motionEpsilonM) && motionEpsilonM >= 0
      ? motionEpsilonM
      : infraLodMotionEpsilonM(cameraHeightM);
  return { recompute: movedSq > epsilon * epsilon, lastProbeMs: now };
}
