/** Segmented track history through the globe line contract. Unchanged chunks
 * keep their geometry; only the newest chunk moves as reports arrive. */
import * as geo from '../geo/index.js';
import { rgbaFromCss } from '../layers/shared/color.js';

let trailSeq = 0;
const MIN_SEGMENT_DISTANCE_SQ = 0.01;
const NO_POSITIONS = Object.freeze([]);
export const CHUNK_POINTS = 128;

/** Create a geodesic trail whose occluded segments remain visible, dimmed. */
export function createTrail(engine, { color, width = 2.5 }) {
  const [r, g, b] = rgbaFromCss(color).rgba();
  let destroyed = false;
  let visible = true;
  let frozen = [];
  let tail = NO_POSITIONS;
  let tailLine = null;

  function addLine(positions) {
    const id = `gev-trail:${++trailSeq}`;
    const line = engine.lines.createLine({
      id,
      widthPx: width,
      color: [r, g, b, 0.85],
      depthFailAlpha: 0.4 / 0.85,
      arc: 'geodesic',
      pickId: id,
    });
    line.setPositions(positions);
    line.show(visible);
    return line;
  }

  /** Drop consecutive near-duplicates: zero-length segments add nothing. */
  function dedupe(cartesians) {
    const positions = [];
    for (const position of Array.isArray(cartesians) ? cartesians : []) {
      if (!position) continue;
      const last = positions[positions.length - 1];
      if (
        last &&
        geo.cartesian3.distanceSquared(last, position) < MIN_SEGMENT_DISTANCE_SQ
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
          line: addLine(positions),
        });
        i = end;
      }
    });
    for (const chunk of frozen) if (!kept.has(chunk)) chunk.line.destroy();
    frozen = next;
    tail = nextTail;
    tailLine ??= addLine([]);
    tailLine.setPositions(tail);
    tailLine.show(visible);
  }

  function release() {
    for (const chunk of frozen) chunk.line.destroy();
    frozen = [];
    tail = NO_POSITIONS;
    tailLine?.setPositions(tail);
  }

  return {
    setPositions(positions) {
      this.setSegments([positions]);
    },
    setSegments(segments) {
      if (destroyed) return;
      reconcile(
        (Array.isArray(segments) ? segments : [])
          .map(dedupe)
          .filter((positions) => positions.length >= 2),
      );
    },
    setVisible(next) {
      visible = next !== false;
      tailLine?.show(visible);
      for (const chunk of frozen) chunk.line.show(visible);
    },
    clear() {
      if (!destroyed) release();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      release();
      tailLine?.destroy();
      tailLine = null;
    },
    _chunksForTest() {
      return {
        frozen: frozen.map(({ positions, line }) => ({ positions, line })),
        dynamic: tail.length >= 2 ? [tail] : [],
      };
    },
  };
}
