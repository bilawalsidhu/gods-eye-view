/**
 * @module trailRenderer
 * @description Shared track-history renderer (PRD WS-F F4; rebuilt round 6,
 * 2026-07-06).
 *
 * One trail = one ENTITY polyline. Round 6 replaced the faded per-vertex
 * Primitive for two owner directives from the field:
 *  - "the line must ALWAYS be visible": the Primitive's depthFailAppearance
 *    did not reliably render segments below the photoreal mesh — entity
 *    polylines with `depthFailMaterial` DO (in-repo proof: CCTV's frustum
 *    wireframes read through geometry with exactly this), so occluded
 *    segments now draw dimmed instead of vanishing.
 *  - "show actual tracks, don't style them too much": the tail-fade is gone;
 *    the whole history renders at one readable alpha (dimmer where it passes
 *    behind/below geometry).
 *
 * A trail with breaks draws each segment separately and nothing between
 * them. Every segment is cut into chunks of up to CHUNK_POINTS points;
 * adjacent chunks share their boundary point, so the line has no seam. A
 * chunk that can no longer change (every chunk except the newest one of the
 * newest segment) is FROZEN: an entity with constant positions, built once as
 * static geometry, so it costs nothing per frame. Only the newest chunk stays
 * dynamic. A freshly frozen chunk is also drawn dynamically until its static
 * geometry is in the scene, so freezing never shows a blank frame. A chunk is
 * identified by its position objects, so a chunk survives every update that
 * keeps those points: appends, a backfill prepended ahead of it, or the
 * oldest points dropping off the front (which rebuilds only the first chunk).
 *
 * Trails update at poll cadence (~15-60 s) plus once on history backfill, so
 * assigning a fresh positions array per update is cheap. `allowPicking` has
 * no entity equivalent; the polyline entity is excluded from clicks by never
 * carrying a pick id the layers' click handlers resolve.
 */
import * as Cesium from 'cesium';
import { registerPickOwner } from './pickRegistry.js';

// Round 6: trail ENTITIES are pickable (the old Primitive had
// allowPicking:false). A trail hugs its aircraft, so an unclaimed pick would
// read as "empty space" in every layer's click handler and deselect the very
// plane being tracked. Claiming the 'gev-trail:' id namespace makes
// isOwnedByOtherLayer() true for every layer — clicking a trail is a no-op
// everywhere. Registered once at module load; the predicate is pure.
registerPickOwner('trails', (pickedId) =>
  String(pickedId).startsWith('gev-trail:'),
);

/** @type {number} Uniquifier for trail entity ids (Cesium requires unique entity ids). */
let _trailSeq = 0;

/** @constant {number} Alpha where the trail passes the depth test. */
const TRAIL_ALPHA = 0.85;
/** @constant {number} Alpha where the trail is behind/below scene geometry —
 *  visible (owner: never vanish) but readable as occluded. */
const TRAIL_OCCLUDED_ALPHA = 0.4;
/** @constant {number} Squared distance (m^2) below which consecutive points are merged. */
const MIN_SEGMENT_DISTANCE_SQ = 0.01;
/** @constant {Cesium.Cartesian3[]} What a spare dynamic polyline draws. */
const NO_POSITIONS = Object.freeze([]);
/** @constant {number} Points per chunk; adjacent chunks share one point. */
export const CHUNK_POINTS = 128;
/** @constant {number} Visible frames a frozen chunk's stand-in waits for its
 *  static geometry before it is dropped anyway. */
const STAND_IN_MAX_FRAMES = 600;

/**
 * Create an always-visible polyline trail bound to a viewer.
 * @param {Cesium.Viewer} viewer - Viewer whose entity collection owns the trail.
 * @param {object} options - Trail options.
 * @param {string} options.color - CSS color string for the trail hue.
 * @param {number} [options.width=2.5] - Polyline width in pixels.
 * @returns {{setPositions: function(Cesium.Cartesian3[]): void, setSegments: function(Cesium.Cartesian3[][]): void, setVisible: function(boolean): void, clear: function(): void, destroy: function(): void}}
 *   Trail handle: setPositions replaces the geometry with one line,
 *   setSegments with one line per segment, setVisible temporarily hides it
 *   without discarding history, clear empties it, and destroy removes the
 *   entities permanently.
 */
export function createTrail(viewer, { color, width = 2.5 }) {
  const baseColor = Cesium.Color.fromCssColorString(color);
  const material = baseColor.withAlpha(TRAIL_ALPHA);
  const depthFailMaterial = baseColor.withAlpha(TRAIL_OCCLUDED_ALPHA);
  let destroyed = false;
  let visible = true;
  /** @type {{positions: Cesium.Cartesian3[], entity: Cesium.Entity, standIn: boolean, frames: number}[]} */
  let frozen = [];
  /** Newest chunk of the newest segment: the only part that changes. */
  let tail = NO_POSITIONS;
  /** What the dynamic polylines draw: the tail, then frozen chunks whose
   *  static geometry is not in the scene yet. */
  let dynamicRuns = [];
  /** @type {Cesium.Entity[]} Pooled dynamic polylines; spares draw nothing. */
  const dynamicEntities = [];
  let removeReadyListener = null;
  const scratchSphere = new Cesium.BoundingSphere();

  const usable = () => !destroyed && viewer && !viewer.isDestroyed();

  function polyline(positions) {
    return {
      positions,
      width,
      material,
      // The owner-locked rule (round 6): a segment below the photoreal
      // mesh renders dimmed — it must never disappear into the ground.
      depthFailMaterial,
      // Round 8 (owner: UAL1104's Pacific trail "cutting through the
      // globe"): NONE draws straight 3D chords between waypoints — over a
      // sparse trans-oceanic trace a single segment spans hundreds of km
      // and tunnels through the planet. GEODESIC subdivides each segment
      // along the curved surface (heights interpolated), so long legs hug
      // the globe instead of chording through it.
      arcType: Cesium.ArcType.GEODESIC,
    };
  }

  function addEntity(positions) {
    return viewer.entities.add({
      id: `gev-trail:${++_trailSeq}`,
      show: visible,
      polyline: polyline(positions),
    });
  }

  function removeEntity(entity) {
    try {
      viewer.entities.remove(entity);
    } catch {
      /* torn down */
    }
  }

  function syncDynamic() {
    dynamicRuns = [];
    if (tail.length >= 2) dynamicRuns.push(tail);
    for (const chunk of frozen)
      if (chunk.standIn) dynamicRuns.push(chunk.positions);
    while (dynamicEntities.length < Math.max(1, dynamicRuns.length)) {
      const index = dynamicEntities.length;
      dynamicEntities.push(
        addEntity(
          // CallbackProperty so a positions swap never rebuilds the entity —
          // Cesium re-reads on change; `false` marks it non-constant.
          new Cesium.CallbackProperty(
            () => dynamicRuns[index] ?? NO_POSITIONS,
            false,
          ),
        ),
      );
    }
  }

  /** Whether a frozen chunk's static geometry is drawn in the scene. */
  function staticReady(chunk) {
    const display = viewer.dataSourceDisplay;
    if (typeof display?.getBoundingSphere !== 'function') return true;
    if (!visible) return false;
    chunk.frames += 1;
    if (chunk.frames > STAND_IN_MAX_FRAMES) return true;
    try {
      return (
        display.getBoundingSphere(chunk.entity, false, scratchSphere) ===
        Cesium.BoundingSphereState.DONE
      );
    } catch {
      return false;
    }
  }

  /** Drop stand-ins whose static geometry is in; stop listening when none are left. */
  function resolveStandIns() {
    if (!usable()) return;
    let changed = false;
    for (const chunk of frozen) {
      if (chunk.standIn && staticReady(chunk)) {
        chunk.standIn = false;
        changed = true;
      }
    }
    if (changed) syncDynamic();
    if (!frozen.some((chunk) => chunk.standIn)) stopListening();
  }

  function stopListening() {
    if (removeReadyListener) removeReadyListener();
    removeReadyListener = null;
  }

  function listenForStandIns() {
    if (removeReadyListener) return;
    const event = viewer.scene?.postRender;
    if (typeof event?.addEventListener !== 'function') {
      resolveStandIns();
      return;
    }
    removeReadyListener = event.addEventListener(resolveStandIns);
  }

  /** Drop consecutive near-duplicates: zero-length segments add nothing. */
  function dedupe(cartesians) {
    const positions = [];
    for (const position of Array.isArray(cartesians) ? cartesians : []) {
      if (!position) continue;
      const last = positions[positions.length - 1];
      if (
        last &&
        Cesium.Cartesian3.distanceSquared(last, position) <
          MIN_SEGMENT_DISTANCE_SQ
      )
        continue;
      positions.push(position);
    }
    return positions;
  }

  /** Whether `chunk` holds exactly the same position objects as `seg` from `start`. */
  function sameRun(chunk, seg, start) {
    const positions = chunk.positions;
    if (start + positions.length > seg.length) return false;
    for (let k = 0; k < positions.length; k++)
      if (positions[k] !== seg[start + k]) return false;
    return true;
  }

  /**
   * Cut segments into chunks, reusing every frozen chunk whose points are
   * still drawn in the same order. New chunks end where a reusable one begins,
   * so dropping the oldest point rebuilds only the first chunk.
   */
  function reconcile(segments) {
    const byStart = new Map();
    for (const chunk of frozen) byStart.set(chunk.positions[0], chunk);
    const kept = new Set();
    const reusable = (seg, j) => {
      const chunk = byStart.get(seg[j]);
      return chunk && !kept.has(chunk) && sameRun(chunk, seg, j) ? chunk : null;
    };
    const next = [];
    let nextTail = NO_POSITIONS;
    segments.forEach((seg, s) => {
      const newest = s === segments.length - 1;
      let i = 0;
      while (i < seg.length - 1) {
        const existing = reusable(seg, i);
        if (existing) {
          kept.add(existing);
          next.push(existing);
          i += existing.positions.length - 1;
          continue;
        }
        if (newest && seg.length - i <= CHUNK_POINTS) {
          nextTail = seg.slice(i);
          break;
        }
        let end = Math.min(seg.length - 1, i + CHUNK_POINTS - 1);
        for (let j = i + 1; j < end; j++) {
          if (reusable(seg, j)) {
            end = j;
            break;
          }
        }
        const positions = seg.slice(i, end + 1);
        next.push({
          positions,
          entity: addEntity(positions),
          standIn: true,
          frames: 0,
        });
        i = end;
      }
    });
    for (const chunk of frozen)
      if (!kept.has(chunk)) removeEntity(chunk.entity);
    frozen = next;
    tail = nextTail;
    syncDynamic();
    if (frozen.some((chunk) => chunk.standIn)) listenForStandIns();
    else stopListening();
  }

  function release() {
    stopListening();
    for (const chunk of frozen) removeEntity(chunk.entity);
    frozen = [];
    tail = NO_POSITIONS;
    dynamicRuns = [];
  }

  return {
    /**
     * Replace the trail geometry with one chronological position list
     * (oldest first). Fewer than 2 distinct positions clears the trail.
     * @param {Cesium.Cartesian3[]} cartesians - Positions, oldest -> newest.
     */
    setPositions(cartesians) {
      this.setSegments([cartesians]);
    },

    /**
     * Replace the trail geometry with chronological segments (oldest first).
     * Nothing is drawn between segments. A segment with fewer than 2 distinct
     * positions draws nothing. Pass the same position objects on every
     * update: a chunk whose points are unchanged is never rebuilt.
     * @param {Cesium.Cartesian3[][]} list - Segments, each oldest -> newest.
     */
    setSegments(list) {
      if (!usable()) return;
      reconcile(
        (Array.isArray(list) ? list : [])
          .map(dedupe)
          .filter((positions) => positions.length >= 2),
      );
    },

    /** Temporarily hide/show the trail without discarding accumulated history. */
    setVisible(nextVisible) {
      visible = nextVisible !== false;
      for (const entity of dynamicEntities) entity.show = visible;
      for (const chunk of frozen) chunk.entity.show = visible;
    },

    /** Empty the trail and release its frozen geometry; dynamic polylines stay for re-arm. */
    clear() {
      if (!usable()) return;
      release();
    },

    /** Remove every trail entity permanently (layer disable/teardown). */
    destroy() {
      if (usable()) {
        release();
        for (const entity of dynamicEntities) removeEntity(entity);
      }
      destroyed = true;
      frozen = [];
      tail = NO_POSITIONS;
      dynamicRuns = [];
      dynamicEntities.length = 0;
      stopListening();
    },

    /** Test seam: frozen chunks (positions, stand-in state) and the dynamic runs. */
    _chunksForTest() {
      return {
        frozen: frozen.map((chunk) => ({
          positions: chunk.positions,
          standIn: chunk.standIn,
          entity: chunk.entity,
        })),
        dynamic: dynamicRuns.slice(),
      };
    },
  };
}
