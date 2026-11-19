/**
 * @module trailRenderer
 * @description Shared track-history renderer (PRD WS-F F4; rebuilt round 6,
 * 2026-07-06; drawn through the renderer's draw port since 2026-11).
 *
 * One trail = one line set on the viewer's draw port: the history line and,
 * for layers that draw one, the live head from the last history point to
 * the moving contact. Two owner directives from the field shape it:
 *  - "the line must ALWAYS be visible": where the trail passes behind or
 *    below scene geometry it draws dimmed (the line's depth-fail colour)
 *    instead of vanishing.
 *  - "show actual tracks, don't style them too much": the whole history
 *    renders at one readable alpha (dimmer where it is hidden).
 *
 * The history changes at poll cadence (~15-60 s) plus once on backfill; the
 * head may change every frame. Either is rebuilt alone, under the same pick
 * id, without rebuilding the other.
 *
 * A history with breaks (`setSegments`) draws each segment separately and
 * nothing between them. Every segment is cut into lines of up to
 * CHUNK_POINTS points; adjacent lines share their boundary point, so the
 * trail has no seam. A line is identified by its position objects, so it is
 * never rewritten by an update that keeps those points: appends, a backfill
 * prepended ahead of it, or the oldest points dropping off the front (which
 * rewrites only the first line). Only the newest line of the newest segment
 * changes as the trail grows, and the draw port lets lines that stop
 * changing settle into static geometry.
 */
import { cssColor } from '../render/color.js';
import { findDraw } from '../render/rendererOf.js';
import { registerPickOwner } from './pickRegistry.js';

// Trail lines are pickable (a click on one must not fall through to the
// ground under it). A trail hugs its aircraft, so an unclaimed pick would
// read as "empty space" in every layer's click handler and deselect the very
// plane being tracked. Claiming the 'gev-trail:' id namespace makes
// isOwnedByOtherLayer() true for every layer — clicking a trail is a no-op
// everywhere. Registered once at module load; the predicate is pure.
registerPickOwner('trails', (pickedId) =>
  String(pickedId).startsWith('gev-trail:'),
);

/** @type {number} Uniquifier for trail set and line ids. */
let _trailSeq = 0;

/** @constant {number} Alpha where the trail passes the depth test. */
const TRAIL_ALPHA = 0.85;
/** @constant {number} Alpha where the trail is behind/below scene geometry —
 *  visible (owner: never vanish) but readable as occluded. */
const TRAIL_OCCLUDED_ALPHA = 0.4;
/** @constant {number} Alpha of the live head, and where it is hidden. */
const HEAD_ALPHA = 0.9;
const HEAD_OCCLUDED_ALPHA = 0.45;
/** @constant {number} Squared distance (m^2) below which consecutive points are merged. */
const MIN_SEGMENT_DISTANCE_SQ = 0.01;
/** @constant {number} Points per history line; adjacent lines share one point. */
export const CHUNK_POINTS = 128;

/** `css` (any CSS colour) at `alpha`, as a renderer colour. */
function colorAt(css, alpha) {
  const [r, g, b] = cssColor(css) ?? [1, 1, 1];
  return [r, g, b, alpha];
}

const distanceSq = (a, b) =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

/**
 * Consecutive near-duplicates dropped (zero-length segments add nothing),
 * as plain ECEF; empty when fewer than 2 distinct positions remain.
 * @param {Array<{x: number, y: number, z: number}|null|undefined>} given
 */
function trailPositions(given) {
  const positions = [];
  for (const position of Array.isArray(given) ? given : []) {
    if (!position) continue;
    const last = positions[positions.length - 1];
    if (last && distanceSq(last, position) < MIN_SEGMENT_DISTANCE_SQ) continue;
    positions.push({ x: position.x, y: position.y, z: position.z });
  }
  return positions.length >= 2 ? positions : [];
}

/** `trailPositions`, keeping the given position objects (a line's identity). */
function keptPositions(given) {
  const positions = [];
  for (const position of Array.isArray(given) ? given : []) {
    if (!position) continue;
    const last = positions[positions.length - 1];
    if (last && distanceSq(last, position) < MIN_SEGMENT_DISTANCE_SQ) continue;
    positions.push(position);
  }
  return positions.length >= 2 ? positions : [];
}

const plain = ({ x, y, z }) => ({ x, y, z });

/** Whether `chunk` holds exactly the same position objects as `seg` from `start`. */
function sameRun(chunk, seg, start) {
  const positions = chunk.positions;
  if (start + positions.length > seg.length) return false;
  for (let k = 0; k < positions.length; k++)
    if (positions[k] !== seg[start + k]) return false;
  return true;
}

/**
 * Create an always-visible polyline trail bound to a viewer.
 * @param {object} viewer - Viewer whose renderer draws the trail.
 * @param {object} options - Trail options.
 * @param {string} options.color - CSS colour of the trail.
 * @param {number} [options.width=2.5] - Line width in pixels.
 * @returns {{setPositions: function(Array<{x: number, y: number, z: number}>): void, setSegments: function(Array<Array<{x: number, y: number, z: number}>>): void, setHead: function(Array<{x: number, y: number, z: number}>|null): void, setVisible: function(boolean): void, clear: function(): void, destroy: function(): void}}
 *   Trail handle: setPositions replaces the history with one line,
 *   setSegments with one per segment, setHead the live head
 *   (null or fewer than 2 positions: none), setVisible temporarily hides
 *   both without discarding them, clear empties both, and destroy removes
 *   the trail permanently.
 */
export function createTrail(viewer, { color, width = 2.5 }) {
  const seq = ++_trailSeq;
  const bodyId = `gev-trail:${seq}`;
  const headId = `gev-trail:${seq}:head`;
  let destroyed = false;
  let visible = true;
  /** @type {import('../render/contract/draw').DrawSet<import('../render/contract/draw').LineItem>|null} */
  let set = null;
  /** Each line as last drawn and its positions' key, by id, to skip a redraw that changes nothing. */
  const drawn = new Map();
  /** The head given while the trail is hidden, drawn once it shows. */
  let pendingHead = null;
  /** History lines before the newest one, oldest first: each line's id and
   *  the position objects it was drawn from, which never change. */
  let chunks = [];
  let chunkSeq = 0;

  function ensureSet() {
    if (set || destroyed || !viewer || viewer.isDestroyed?.()) return set;
    set =
      findDraw(viewer)?.lines({ id: `trail:${seq}`, show: visible }) ?? null;
    return set;
  }

  /**
   * Draw one of the trail's lines, or with no positions hide it. A hidden
   * line stays in the set, so the other is never rebuilt for it.
   */
  function draw(id, positions, alpha, occludedAlpha, mode = 'geodesic') {
    if (destroyed || !viewer || viewer.isDestroyed?.()) return;
    const lines = ensureSet();
    if (!lines) return;
    const key = positions.map(({ x, y, z }) => `${x},${y},${z}`).join(';');
    const was = drawn.get(id);
    if ((was?.key ?? '') === key) return;
    if (!positions.length) {
      const hidden = { ...was.item, show: false };
      drawn.set(id, { key, item: hidden });
      lines.upsert([hidden]);
      return;
    }
    const item = lineItem(id, positions, alpha, occludedAlpha, mode);
    drawn.set(id, { key, item });
    lines.upsert([item]);
  }

  function lineItem(id, positions, alpha, occludedAlpha, mode = 'geodesic') {
    return {
      id,
      positions,
      widthPx: width,
      mode,
      style: { kind: 'solid', color: colorAt(color, alpha) },
      // The owner-locked rule (round 6): a segment below the photoreal
      // mesh renders dimmed — it must never disappear into the ground.
      depthFail: { kind: 'solid', color: colorAt(color, occludedAlpha) },
    };
  }

  /**
   * Cut the history's segments into lines, keeping every line whose points
   * are still drawn in the same order. New lines end where a kept one
   * begins, so dropping the oldest point rewrites only the first line. The
   * newest line of the newest segment is the body line, the one that grows.
   * @param {Array<Array<{x: number, y: number, z: number}>>} list
   */
  function setSegments(list) {
    if (destroyed || !viewer || viewer.isDestroyed?.()) return;
    const lines = ensureSet();
    if (!lines) return;
    const segments = (Array.isArray(list) ? list : [])
      .map(keptPositions)
      .filter((positions) => positions.length >= 2);
    const byStart = new Map();
    for (const chunk of chunks) byStart.set(chunk.positions[0], chunk);
    const kept = new Set();
    const reusable = (seg, j) => {
      const chunk = byStart.get(seg[j]);
      return chunk && !kept.has(chunk) && sameRun(chunk, seg, j) ? chunk : null;
    };
    const next = [];
    const added = [];
    let tail = [];
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
          tail = seg.slice(i);
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
        const chunk = { id: `${bodyId}:${++chunkSeq}`, positions };
        next.push(chunk);
        added.push(
          lineItem(
            chunk.id,
            positions.map(plain),
            TRAIL_ALPHA,
            TRAIL_OCCLUDED_ALPHA,
          ),
        );
        i = end;
      }
    });
    const gone = chunks.filter((chunk) => !kept.has(chunk));
    chunks = next;
    if (gone.length) lines.remove(gone.map((chunk) => chunk.id));
    if (added.length) lines.upsert(added);
    // Round 8 (owner: UAL1104's Pacific trail "cutting through the
    // globe"): straight 3D chords between sparse trans-oceanic
    // waypoints tunnel through the planet; a geodesic line follows the
    // curved surface (heights interpolated) instead.
    draw(bodyId, tail.map(plain), TRAIL_ALPHA, TRAIL_OCCLUDED_ALPHA);
  }

  /**
   * Replace the live head: the segment from the last drawn history point
   * to where the contact is drawn now. It may change every frame: while
   * the trail is hidden it is only kept, and drawn once the trail shows.
   * @param {Array<{x: number, y: number, z: number}>|null} cartesians
   */
  function setHead(cartesians) {
    if (!visible) {
      pendingHead = cartesians ?? [];
      return;
    }
    pendingHead = null;
    // One poll interval long at most: straight is the geodesic to the
    // pixel, and a frame's rebuild stays two positions.
    draw(
      headId,
      trailPositions(cartesians),
      HEAD_ALPHA,
      HEAD_OCCLUDED_ALPHA,
      '3d',
    );
  }

  return {
    /**
     * Replace the trail geometry with a chronological position list
     * (oldest first). Fewer than 2 distinct positions clears the trail.
     * @param {Array<{x: number, y: number, z: number}>} cartesians
     *   ECEF positions, oldest -> newest.
     */
    setPositions(cartesians) {
      setSegments([cartesians]);
    },

    /**
     * Replace the trail geometry with chronological segments (oldest
     * first), nothing drawn between them. A segment with fewer than 2
     * distinct positions draws nothing. Pass the same position objects on
     * every update: a line whose points are unchanged is never rewritten.
     * @param {Array<Array<{x: number, y: number, z: number}>>} list
     *   Segments, each oldest -> newest.
     */
    setSegments,

    setHead,

    /** Temporarily hide/show the trail without discarding accumulated history. */
    setVisible(nextVisible) {
      visible = nextVisible !== false;
      if (set) set.show = visible;
      if (visible && pendingHead) setHead(pendingHead);
    },

    /** Empty the trail, keeping its set (cheap re-arm). */
    clear() {
      pendingHead = null;
      if (
        !destroyed &&
        set &&
        !viewer?.isDestroyed?.() &&
        (drawn.size || chunks.length)
      ) {
        drawn.clear();
        chunks = [];
        set.clear();
      }
    },

    /** Remove the trail permanently (layer disable/teardown). */
    destroy() {
      destroyed = true;
      try {
        set?.dispose();
      } catch {
        /* torn down */
      }
      set = null;
      drawn.clear();
      chunks = [];
    },
  };
}
