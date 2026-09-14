import * as Cesium from 'cesium';
import {
  CABLE_REFERENCE_LABEL_WINNER_CAP,
  CABLE_REFERENCE_LABEL_MAX_DISTANCE_M,
  BASE_CABLE_COLOR,
  BASE_LANDING_COLOR,
  CABLE_OVERLAY_SOURCE_ID,
  CABLE_OVERLAY_COLLISION_CAPACITY,
  defaultSweepClock,
  CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS,
  CABLE_SWEEP_MOTION_EPSILON_M,
  STEM_TARGET_PX,
  CABLE_STEM_TIP_EPSILON_SQ,
} from './policy.js';

/**
 * Select the nearest visible cable references without exceeding the bounded
 * cohort cap the shared host is offered.
 * @param {object[]} records Records annotated with `visible` and `distanceM`.
 * @param {number} [limit]
 * @returns {object[]}
 */

export function selectCableReferenceLabelWinners(
  records,
  limit = CABLE_REFERENCE_LABEL_WINNER_CAP,
) {
  const cap = Math.max(
    0,
    Math.min(CABLE_REFERENCE_LABEL_WINNER_CAP, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(records) || cap === 0) return [];
  return records
    .filter(
      (record) =>
        record?.visible === true &&
        record.label &&
        Number.isFinite(record.distanceM) &&
        record.distanceM <= CABLE_REFERENCE_LABEL_MAX_DISTANCE_M,
    )
    .sort(
      (a, b) =>
        a.distanceM - b.distanceM ||
        String(a.entity?.id || '').localeCompare(String(b.entity?.id || '')),
    )
    .slice(0, cap);
}

/**
 * Distance-derived arbiter priority. Quantized to 50 km buckets so a slowly
 * moving camera does not reshuffle equal-rank labels on every sweep; nearer
 * references still win collisions, matching the shipped nearest-first feel.
 * @param {number} distanceM
 * @returns {number}
 */

export function cableReferencePriority(distanceM) {
  const distance = Number.isFinite(distanceM)
    ? Math.max(0, distanceM)
    : CABLE_REFERENCE_LABEL_MAX_DISTANCE_M;
  return 1000 - Math.round(distance / 50000);
}

/**
 * Build one shared-host ambient label for a cable or landing-point reference.
 * The entry stays attached to the record's mutable stem-tip Cartesian and is
 * created once per record; only `priority` is refreshed per sweep.
 * `interactive: false` follows the infrastructure precedent — the depth-tested
 * native point/stem/line remains the click surface, and a non-interactive
 * label keeps the host's per-frame accessibility/hit sync allocation-free.
 * @param {object} record Reference record ({ id, kind, label, tip }).
 * @returns {object}
 */

export function createCableOverlayEntry(record) {
  const kind = record?.kind === 'landing-point' ? 'landing-point' : 'cable';
  return {
    id: String(record?.id || ''),
    position: record?.tip,
    variant: 'label',
    title: String(record?.label || ''),
    accent: kind === 'cable' ? BASE_CABLE_COLOR : BASE_LANDING_COLOR,
    priority: cableReferencePriority(record?.distanceM),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    minDistance: 0,
    maxDistance: CABLE_REFERENCE_LABEL_MAX_DISTANCE_M,
    distanceFadeStartRatio: 0.7,
    // Former native scaleByDistance curve, unchanged: 1.0× at 250 km → 0.62×
    // at 9,000 km.
    distanceScale: {
      near: 250000,
      nearValue: 1,
      far: 9000000,
      farValue: 0.62,
    },
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * Bind the cable layer's host visibility and entry lifecycle to the shared
 * world overlay (same contract as the infrastructure publisher). The layer
 * supports re-init after destroy (legacy contract), so its teardown path is
 * hide() — clear the published source and go invisible while staying
 * reusable. There is deliberately no permanent-destroy method: a hidden
 * publisher already drops late publishes until the next show().
 * @param {object} [options]
 * @param {string} [options.sourceId]
 * @param {object} [options.host] Test seam for the three host lifecycle calls.
 * @returns {{show:function():void,publish:function(object[]):void,hide:function():void}}
 */

export function createCableOverlayPublisher({
  sourceId = CABLE_OVERLAY_SOURCE_ID,
  host,
} = {}) {
  let visible = false;
  let published = false;
  const sourceOptions = {
    cohortLimit: CABLE_REFERENCE_LABEL_WINNER_CAP,
    collisionCapacity: CABLE_OVERLAY_COLLISION_CAPACITY,
    moving: false,
  };

  return {
    show() {
      if (visible) return;
      visible = true;
      host.setVisible(sourceId, true);
    },
    publish(entries) {
      if (!visible) return;
      host.setEntries(sourceId, entries, sourceOptions);
      published = entries.length > 0;
    },
    hide() {
      if (published) host.clearSource(sourceId);
      if (visible) host.setVisible(sourceId, false);
      visible = false;
      published = false;
    },
  };
}

/**
 * Dirty gate for the reference sweep. TWO dirty conditions, no timer:
 *
 * 1. EVENT (primary): the sweep runs on the first frame after a camera
 *    `moveEnd`, layer enable, or load completion. The former 500 ms timer
 *    path re-sized stems while frames were flowing, and every re-size
 *    rebuilt the 2,629-instance batched translucent stem primitive
 *    (measured: 12 rebuilds in 6 s with the replacement primitive unready
 *    for 46/360 frames — the felt hitch). Stem lengths are therefore
 *    deliberately stale mid-drag/mid-flight and settle on release;
 *    reference visibility and label winners go stale the same way, and the
 *    shared host keeps reprojecting the published positions per frame.
 * 2. MOTION FALLBACK: `moveEnd` covers drags, one-shot `setView`, and voice
 *    `flyTo`, but a TRACKED-entity follow camera or an orbit never emits it,
 *    so condition 1 alone starves those sessions forever (frozen horizon
 *    visibility, frozen stems, stale label winners for as long as tracking
 *    lasts). While frames render, the gate therefore samples the camera at
 *    most once per `CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS` and re-arms itself
 *    only when the camera has actually travelled past
 *    `CABLE_SWEEP_MOTION_EPSILON_M` since the last sweep.
 *
 * A PARKED camera still costs exactly zero sweeps: the probe compares against
 * the last swept position (never the previous frame), so neither a frozen
 * camera nor sub-epsilon numeric jitter ever accumulates into a sweep, and
 * the per-frame cost of the fallback is one clock read plus one subtraction.
 * Position is the only motion channel because it is the only camera input the
 * sweep consumes — the horizon occluder, the reference distances, the stem
 * sizing, and the winner ranks all derive from `positionWC` alone, so a
 * heading-only rotation cannot change a single sweep output and deliberately
 * does not spend one.
 * @param {object} [options]
 * @param {function():number} [options.now] Monotonic clock (test seam).
 * @param {number} [options.probeIntervalMs]
 * @param {number} [options.motionEpsilonM]
 */

export function createCableReferenceSweepGate({
  now = defaultSweepClock,
  probeIntervalMs = CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS,
  motionEpsilonM = CABLE_SWEEP_MOTION_EPSILON_M,
} = {}) {
  const motionEpsilonSq = motionEpsilonM ** 2;
  // Preallocated: the probe clones into it, so a moving camera allocates
  // nothing per frame.
  const lastSweptPosition = new Cesium.Cartesian3();
  let hasSweptPosition = false;
  let dirty = true;
  let lastProbeAt = -Infinity;

  /** Arm the next probe window and adopt the camera position being swept. */
  function accept(camera, time) {
    lastProbeAt = time;
    const position = camera?.positionWC;
    hasSweptPosition = Boolean(position);
    if (position) Cesium.Cartesian3.clone(position, lastSweptPosition);
    return true;
  }

  return {
    markDirty() {
      dirty = true;
    },
    /**
     * @param {Cesium.Camera} [camera] Live camera; omit to disable the motion
     *   fallback entirely (pure dirty-only gate).
     * @returns {boolean}
     */
    shouldRun(camera) {
      if (dirty) {
        dirty = false;
        return accept(camera, now());
      }
      if (!camera) return false;
      // Cheapest possible per-frame path: a clock read and a subtraction. The
      // camera getter is only touched once the probe window has actually
      // opened, and the window re-arms whether or not the probe sweeps.
      const time = now();
      if (time - lastProbeAt < probeIntervalMs) return false;
      lastProbeAt = time;
      const position = camera.positionWC;
      if (!position) return false;
      if (
        hasSweptPosition &&
        Cesium.Cartesian3.distanceSquared(position, lastSweptPosition) <=
          motionEpsilonSq
      ) {
        return false;
      }
      return accept(camera, time);
    },
    reset() {
      dirty = true;
      lastProbeAt = -Infinity;
      hasSweptPosition = false;
    },
  };
}

/**
 * Recompute one staticized stem on the sweep cadence. Replaces the former
 * per-frame `CallbackProperty` pair: constant properties are redefined only
 * when the camera-scaled tip moved beyond the settle epsilon, and the two
 * preallocated position buffers alternate so each real change raises exactly
 * one geometry notification (the localGeojson double-buffer pattern).
 * @param {object} record Reference record with entity/base/tip/nextTip/buffers.
 * @param {Cesium.Cartesian3} cameraPositionWC
 * @param {number} canvasHeight CSS-pixel canvas height.
 * @param {number} fov Camera frustum field of view (radians).
 * @returns {boolean} True when the stem geometry was redefined.
 */

export function updateCableReferenceStem(
  record,
  cameraPositionWC,
  canvasHeight,
  fov,
) {
  const distance = Cesium.Cartesian3.distance(cameraPositionWC, record.base);
  const effectiveDistance = Math.max(distance, 5000);
  const height = canvasHeight || 1080;
  const fieldOfView = fov || Math.PI / 3;
  const metersPerPixelFactor = (2 * Math.tan(fieldOfView / 2)) / height;
  const tipHeight = Math.max(
    700,
    Math.min(85000, effectiveDistance * metersPerPixelFactor * STEM_TARGET_PX),
  );
  Cesium.Cartesian3.fromDegrees(
    record.reference.lon,
    record.reference.lat,
    tipHeight,
    Cesium.Ellipsoid.WGS84,
    record.nextTip,
  );
  if (
    Cesium.Cartesian3.distanceSquared(record.tip, record.nextTip) <=
    CABLE_STEM_TIP_EPSILON_SQ
  ) {
    return false;
  }
  Cesium.Cartesian3.clone(record.nextTip, record.tip);
  record.stemPositionBufferIndex = 1 - record.stemPositionBufferIndex;
  const stemPositions =
    record.stemPositionBuffers[record.stemPositionBufferIndex];
  stemPositions[0] = record.base;
  stemPositions[1] = record.tip;
  record.entity.position.setValue(record.tip);
  record.entity.polyline.positions.setValue(stemPositions);
  return true;
}

export function clampLabel(value, maxLength = 34) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 3))}...`;
}
