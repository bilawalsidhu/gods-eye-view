/**
 * @module render/stub/motion
 * @description Where a motion segment puts an icon at a time, exactly as
 * the contract's `MotionSegment` describes it.
 */
import { add, eastNorthUp, scale, sub } from './math.js';

const STRAIGHT_RAD_PER_S = 1e-4;

/**
 * @param {import('../contract/draw').MotionSegment} segment
 * @param {{x: number, y: number, z: number}} pos The item's own position (for `hold`).
 * @param {number} t Epoch ms on the set's motion clock.
 * @returns {{x: number, y: number, z: number}}
 */
export function motionPosition(segment, pos, t) {
  switch (segment.kind) {
    case 'hold':
      return pos;
    case 'lerp': {
      const span = segment.t1 - segment.t0;
      const s =
        span > 0
          ? Math.min(1, Math.max(0, (t - segment.t0) / span))
          : t >= segment.t1
            ? 1
            : 0;
      return add(segment.from, scale(sub(segment.to, segment.from), s));
    }
    case 'arc': {
      const dt = Math.min(
        segment.maxDtS,
        Math.max(segment.minDtS, (t - segment.t0) / 1000),
      );
      const track = (segment.trackDeg * Math.PI) / 180;
      const w = (segment.turnRateDps * Math.PI) / 180;
      const v = segment.speedMps;
      let east;
      let north;
      if (Math.abs(w) < STRAIGHT_RAD_PER_S) {
        east = v * dt * Math.sin(track);
        north = v * dt * Math.cos(track);
      } else {
        east = (v / w) * (Math.cos(track) - Math.cos(track + w * dt));
        north = (v / w) * (Math.sin(track + w * dt) - Math.sin(track));
      }
      const up = (segment.climbMps ?? 0) * dt;
      const enu = eastNorthUp(segment.fix);
      return add(
        segment.fix,
        add(add(scale(enu.x, east), scale(enu.y, north)), scale(enu.z, up)),
      );
    }
    default:
      throw new Error(`unknown motion segment ${segment.kind}`);
  }
}
