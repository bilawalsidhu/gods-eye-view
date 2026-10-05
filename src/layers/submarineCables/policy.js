import * as Cesium from 'cesium';

export const BASE_CABLE_COLOR = '#39d5ff';

export const BASE_LANDING_COLOR = '#8fffd2';

export const STEM_TARGET_PX = 66;

export const CABLE_REFERENCE_LABEL_MAX_DISTANCE_M = 9000000;

/** Bounded nearest-visible cohort the layer offers the shared host. */

export const CABLE_REFERENCE_LABEL_WINNER_CAP = 160;

/** Shared world-overlay source id (matches the layer id). */

export const CABLE_OVERLAY_SOURCE_ID = 'telegeography-submarine-cables';

/** Shared ambient-label paint budget, matching the infrastructure sources. */

export const CABLE_OVERLAY_COLLISION_CAPACITY = 96;

/** Ignore sub-metre camera-derived stem-tip noise at camera settle. */

export const CABLE_STEM_TIP_EPSILON_M = 0.5;

export const CABLE_STEM_TIP_EPSILON_SQ = CABLE_STEM_TIP_EPSILON_M ** 2;

/**
 * Motion-fallback probe window. Cameras that never emit `moveEnd` (tracked
 * entities, orbits) would otherwise starve the dirty-only sweep forever, so
 * the gate samples camera motion at most this often while frames render.
 */

export const CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS = 2000;

/**
 * Camera displacement that counts as meaningful motion for that probe. Stem
 * tip height is ~8.5% of camera distance at the shipped 66 px target, so
 * 250 m of camera travel moves a tip ~21 m; below that the frozen sweep is
 * visually indistinguishable and `moveEnd` settles it exactly.
 */

export const CABLE_SWEEP_MOTION_EPSILON_M = 250;

/**
 * Phase-5 depth decision, REVISED 2026-08-18: Option 2. Cable reference text
 * now renders in the shared world-overlay host (horizon-cull + keyhole fade,
 * no per-label tile depth test), superseding the 2026-08-02 Option-1 native
 * `LabelGraphics` exception. The native path evaluated 2 `CallbackProperty`
 * channels per reference entity per frame (5,258 across the 2,629-reference
 * dataset) and re-batched a 160-label `LabelCollection` on every sweep — the
 * layer alone cost ~9.5 ms/frame during camera motion. The depth cue this
 * trades away (photoreal tiles occluding label TEXT at low, city-level
 * cameras) matches the sibling dams/datacenters sources, which shipped
 * host-composited under the same ruling; the anchor points/stems remain
 * Cesium-native and depth-tested. See
 * the world-overlay consolidation design notes ("Depth-testing
 * decision") for both dated decisions.
 */

export const CABLE_LABEL_DEPTH_DECISION = Object.freeze({
  option: 2,
  decidedAt: '2026-08-18',
  supersedes: '2026-08-02',
  depthTested: false,
});

/**
 * `MAP_STACKS` ids that render imagery on the SHOWN Cesium globe (the ion
 * Bing stacks + OSM). Deliberately an explicit allowlist, not "anything that
 * is not photoreal": an id this module has never heard of is UNKNOWN, and
 * unknown must reach the documented BOTH fallback rather than being asserted
 * onto the terrain surface. A stack added to `MAP_STACKS` without being added
 * here therefore degrades to the safe pre-optimization behavior (visible on
 * every surface) instead of vanishing — and the per-stack unit test walks the
 * real `MAP_STACKS` so the omission is caught loudly.
 */

export const CABLE_GLOBE_STACK_IDS = Object.freeze(
  new Set(['bing-aerial', 'bing-labels', 'esri-imagery', 'osm']),
);

/** EntityCluster's private marker collections and their required types. */

export const MARKER_COLLECTION_EXPECTATIONS = Object.freeze([
  Object.freeze({
    key: '_billboardCollection',
    type: Cesium.BillboardCollection,
  }),
  Object.freeze({
    key: '_pointCollection',
    type: Cesium.PointPrimitiveCollection,
  }),
]);

/**
 * Monotonic clock for the sweep gate's motion probe. A hoisted declaration:
 * the module's `export default createTeleGeographySubmarineCableLayer()`
 * runs before this point in source order.
 * @returns {number}
 */

export function defaultSweepClock() {
  return typeof performance === 'object' &&
    typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
