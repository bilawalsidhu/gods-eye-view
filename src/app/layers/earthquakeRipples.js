import { registerWorldOverlayPaintLane } from '../../overlays/worldOverlay.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import {
  earthquakeContourRings,
  earthquakeContourScale,
  earthquakeContourShape,
  earthquakeRippleRings,
  EARTHQUAKE_RIPPLE_PERIOD_MS,
} from '../../layers/earthquakes/model.js';

/** Points around each contour line: smooth at the largest disc on screen. */
export const RIPPLE_RING_SEGMENTS = 96;
/** An index contour's width, and every other line's. */
const INDEX_WIDTH_PX = 2;
const LINE_WIDTH_PX = 1.1;
/**
 * The overlay lane the lines paint in: the magnitude labels' own. A lane's
 * custom painters run before its entries, so the lines sit under the labels
 * and under the selected quake's card.
 */
export const RIPPLE_PAINT_LANE = 'ambient-label';
/**
 * The selected disc's fill, [offset, alpha] from the epicentre (0) to its
 * outer circle (1): strongest in the middle, fading out to nothing at the
 * edge.
 */
export const DISC_FADE = Object.freeze([
  [0, 0.42],
  [0.35, 0.26],
  [0.75, 0.1],
  [1, 0],
]);
/**
 * Each contour wave's fill, out to its own line: clear inside, tinting
 * toward the line; times the wave's own fade.
 */
export const WAVE_FADE = Object.freeze([
  [0, 0],
  [0.55, 0],
  [1, 0.2],
]);

/**
 * `rgb(r,g,b)` (or `rgba`) as a function of alpha, for gradient stops; any
 * other colour keeps its own alpha.
 */
export function cssWithAlpha(color) {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(String(color));
  if (!m) return () => color;
  const rgb = `${m[1]},${m[2]},${m[3]}`;
  return (alpha) => `rgba(${rgb},${Math.max(0, Math.min(1, alpha))})`;
}

/**
 * How many times the lines run out to the edge after a quake is selected
 * before they rest as still contours and stop asking for frames: earthquakes
 * otherwise hold no render (docs/CURRENT-STATE.md, "Earthquake discs are
 * STATIC geometry"), and a quake can stay selected for hours.
 */
export const RIPPLE_ACTIVE_CYCLES = 3;

let reducedMotionQuery;
/**
 * The viewer's reduced-motion setting, live: the media query is kept, so a
 * change mid-session is read at the next paint and tick.
 */
const reducedMotion = () => {
  try {
    reducedMotionQuery ??=
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    return reducedMotionQuery?.matches === true;
  } catch {
    return false;
  }
};

/** How often the rings re-read the ground height under the quake. */
const HEIGHT_READ_INTERVAL_MS = 500;
/**
 * A ground height the rings accept, in metres: the Dead Sea shore to above
 * Everest. Anything else is a bad sample (a hit on something drawn above
 * the ground, or a broken tile), and the rings stay where they are.
 */
const groundHeightOk = (h) => Number.isFinite(h) && h >= -500 && h <= 9000;

/**
 * The selected earthquake's contour lines, painted on the world overlay:
 * wavy closed lines, shaped by the quake's id (earthquakeContourShape), run
 * from the marker out to the disc's edge and fade there, one after another,
 * for RIPPLE_ACTIVE_CYCLES runs after a quake is selected and only while it
 * is on screen, then rest as still contours. They never cross, and every third is
 * a heavier index contour, as on a topographic map. Nothing is drawn, and no
 * frame is asked for, while no quake is selected. With reduced motion the
 * lines hold still.
 *
 * A line is drawn in the tangent plane at the epicentre: at the largest
 * disc (M6, 64 km) it sits about 320 m above the curved ground at its edge
 * (64² / 2R), about 1.5 px off the drawn disc at the 220 km, -45° framing a
 * label click flies to (900 px tall, 35° field of view); less for smaller
 * quakes, as the offset grows with the square of the radius.
 * @param {object} [deps]
 * @param {Function} [deps.registerLane] `registerWorldOverlayPaintLane`.
 * @param {() => number} [deps.now] Steady clock, ms.
 * @param {(cb: Function) => number} [deps.requestFrame]
 * @param {(handle: number) => void} [deps.cancelFrame]
 * @param {() => boolean} [deps.prefersReducedMotion]
 * @returns {{show: Function, hide: Function, dispose: Function}}
 */
export function createEarthquakeRipples({
  registerLane = registerWorldOverlayPaintLane,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  requestFrame = (cb) => globalThis.requestAnimationFrame?.(cb) ?? null,
  cancelFrame = (handle) => globalThis.cancelAnimationFrame?.(handle),
  prefersReducedMotion = reducedMotion,
} = {}) {
  let lane = null;
  let target = null;
  let frameHandle = null;
  // When the running lines settle into still contours (the selection's
  // bound), and whether the last paint found the quake on screen.
  let startedAt = 0;
  let settlesAt = 0;
  let onScreen = false;
  /** Whether the lines run now: in the window, and motion allowed. */
  const running = () => now() < settlesAt && !prefersReducedMotion();
  // Unit offsets around the line in the epicentre's tangent plane, packed
  // x, y, z per point: north·cos + east·sin.
  const offsets = new Float64Array((RIPPLE_RING_SEGMENTS + 1) * 3);
  const angles = new Float64Array(RIPPLE_RING_SEGMENTS + 1);
  for (let i = 0; i <= RIPPLE_RING_SEGMENTS; i++)
    angles[i] = (2 * Math.PI * i) / RIPPLE_RING_SEGMENTS;

  // Screen points, reused every frame.
  const at = { x: 0, y: 0 };
  const centerAt = { x: 0, y: 0 };
  const eastAt = { x: 0, y: 0 };
  const northAt = { x: 0, y: 0 };

  /** Project an ECEF point to CSS pixels; false when it is behind the eye. */
  function project(frame, px, py, pz, out) {
    const m = frame.viewProjectionMatrix;
    const w = m[3] * px + m[7] * py + m[11] * pz + m[15];
    if (w <= 0) return false;
    out.x =
      ((m[0] * px + m[4] * py + m[8] * pz + m[12]) / w / 2 + 0.5) * frame.width;
    out.y =
      (0.5 - (m[1] * px + m[5] * py + m[9] * pz + m[13]) / w / 2) *
      frame.height;
    return true;
  }

  /**
   * Trace one closed line at `fraction` of the disc's radius (`shaped`:
   * as a contour, else the disc's own circle). True when all of it is in
   * front of the eye, so it can be filled.
   */
  function trace(frame, fraction, shaped) {
    const { ctx } = frame;
    const center = target.center;
    const reach = fraction * target.radiusM;
    ctx.beginPath();
    let pen = false;
    let whole = true;
    for (let i = 0; i <= RIPPLE_RING_SEGMENTS; i++) {
      // The last point repeats the first angle, so the line closes.
      const r = shaped
        ? reach * earthquakeContourScale(target.shape, angles[i], fraction)
        : reach;
      const visible = project(
        frame,
        center.x + offsets[i * 3] * r,
        center.y + offsets[i * 3 + 1] * r,
        center.z + offsets[i * 3 + 2] * r,
        at,
      );
      if (!visible) {
        pen = false;
        whole = false;
        continue;
      }
      if (pen) ctx.lineTo(at.x, at.y);
      else ctx.moveTo(at.x, at.y);
      pen = true;
    }
    return whole;
  }

  /**
   * Fill the traced path with a radial gradient laid on the ground: the
   * canvas places a path when it is traced and a gradient when it fills, so
   * under the disc's ground-to-screen transform the gradient's circle
   * becomes the disc's ellipse on screen while the path stays exact.
   * @param {Array<[number, number]>} stops [offset, alpha], out to `reach`.
   */
  function fillGround(ctx, reach, stops) {
    ctx.save();
    ctx.transform(
      eastAt.x - centerAt.x,
      eastAt.y - centerAt.y,
      northAt.x - centerAt.x,
      northAt.y - centerAt.y,
      centerAt.x,
      centerAt.y,
    );
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, reach);
    for (const [offset, alpha] of stops)
      gradient.addColorStop(offset, target.rgba(alpha));
    ctx.fillStyle = gradient;
    ctx.globalAlpha = 1;
    ctx.fill();
    ctx.restore();
  }

  /**
   * Whether any of the disc is in the viewport: its centre's screen point,
   * padded by its larger screen radius (or, seen edge-on, the centre alone).
   */
  function discOnScreen(frame, c, e, n) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return false;
    const pad = Math.max(
      Math.hypot(e.x - c.x, e.y - c.y) || 0,
      Math.hypot(n.x - c.x, n.y - c.y) || 0,
    );
    return (
      c.x + pad >= 0 &&
      c.x - pad <= frame.width &&
      c.y + pad >= 0 &&
      c.y - pad <= frame.height
    );
  }

  /**
   * Re-read the ground height under the quake, at most twice a second while
   * painting: the ground loads and refines as the camera comes in, and the
   * rings move onto it once it differs by more than a metre.
   */
  function settleHeight() {
    if (!target.heightAt) return;
    const at = now();
    if (at - target.heightReadAt < HEIGHT_READ_INTERVAL_MS) return;
    target.heightReadAt = at;
    let height = null;
    try {
      height = target.heightAt();
    } catch {
      height = null;
    }
    if (!groundHeightOk(height) || Math.abs(height - target.heightM) <= 1)
      return;
    target.heightM = height;
    target.center = fromDegrees(target.lon, target.lat, height);
  }

  function paint(frame) {
    if (!target) return;
    const { ctx } = frame;
    settleHeight();
    const center = target.center;
    onScreen = false;
    if (frame.occluder?.isPointVisible?.(center) === false) return;
    const R = target.radiusM;
    // The disc's ground frame on screen: its centre, and a radius east and
    // north. Seen edge-on (or partly behind the eye) it is not filled.
    const centerOk = project(frame, center.x, center.y, center.z, centerAt);
    const eastOk = project(
      frame,
      center.x + target.east.x * R,
      center.y + target.east.y * R,
      center.z + target.east.z * R,
      eastAt,
    );
    const northOk = project(
      frame,
      center.x + target.north.x * R,
      center.y + target.north.y * R,
      center.z + target.north.z * R,
      northAt,
    );
    let fills = centerOk && eastOk && northOk;
    if (fills) {
      const area =
        (eastAt.x - centerAt.x) * (northAt.y - centerAt.y) -
        (eastAt.y - centerAt.y) * (northAt.x - centerAt.x);
      fills = Math.abs(area) > 1;
    }
    onScreen =
      centerOk &&
      discOnScreen(
        frame,
        centerAt,
        eastOk ? eastAt : centerAt,
        northOk ? northAt : centerAt,
      );
    // The disc: strongest at the epicentre, fading out to its outer circle.
    if (fills && trace(frame, 1, false)) fillGround(ctx, 1, DISC_FADE);
    const animate = running();
    const rings = animate
      ? earthquakeRippleRings(now() - startedAt)
      : earthquakeContourRings();
    // Brought back into view while the window lasts: run again.
    if (animate && onScreen && frameHandle === null && lane)
      frameHandle = requestFrame(tick);
    ctx.strokeStyle = target.color;
    ctx.lineJoin = 'round';
    for (const { fraction, alpha, index } of rings) {
      if (!(alpha > 0.01)) continue;
      const whole = trace(frame, fraction, true);
      // Each wave: clear inside, tinting toward its own line, as it fades.
      if (fills && whole)
        fillGround(
          ctx,
          fraction,
          WAVE_FADE.map(([offset, a]) => [offset, a * alpha]),
        );
      ctx.lineWidth = index ? INDEX_WIDTH_PX : LINE_WIDTH_PX;
      ctx.globalAlpha = alpha;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** Ask for one more frame while the lines run (one request at a time). */
  function tick() {
    frameHandle = null;
    if (!target || !lane) return;
    // Settled, or out of sight: one last paint draws the still contours
    // (or nothing), and no more frames are asked for. A paint that finds it
    // on screen again inside the window starts the frames again.
    if (!running() || !onScreen) {
      lane.requestPaint();
      return;
    }
    lane.requestPaint();
    frameHandle = requestFrame(tick);
  }

  function stopFrames() {
    if (frameHandle !== null) cancelFrame(frameHandle);
    frameHandle = null;
  }

  /**
   * Run the contour lines around one quake, replacing any other.
   * @param {{id: string, lon: number, lat: number, heightM?: number, heightAt?: () => number|null, radiusM: number, color: string}} next
   * @param {{restart?: boolean}} [options] `restart: false` updates the
   *   same quake in place (a feed refresh) without running it again.
   */
  function show(next, { restart = true } = {}) {
    if (
      !next ||
      !Number.isFinite(next.lon) ||
      !Number.isFinite(next.lat) ||
      !(next.radiusM > 0)
    ) {
      hide();
      return;
    }
    const sameQuake = target?.id === next.id;
    const lon = (next.lon * Math.PI) / 180;
    const lat = (next.lat * Math.PI) / 180;
    const [sinLon, cosLon] = [Math.sin(lon), Math.cos(lon)];
    const [sinLat, cosLat] = [Math.sin(lat), Math.cos(lat)];
    for (let i = 0; i <= RIPPLE_RING_SEGMENTS; i++) {
      const [c, s] = [Math.cos(angles[i]), Math.sin(angles[i])];
      offsets[i * 3] = c * -sinLat * cosLon + s * -sinLon;
      offsets[i * 3 + 1] = c * -sinLat * sinLon + s * cosLon;
      offsets[i * 3 + 2] = c * cosLat;
    }
    target = {
      id: next.id,
      // On the ground the disc is draped on: the height known now, then
      // re-read while painting (see `settleHeight`), since a label's fly-to
      // starts from far away, before that ground has loaded.
      lon: next.lon,
      lat: next.lat,
      heightM: groundHeightOk(next.heightM) ? next.heightM : 0,
      heightAt: typeof next.heightAt === 'function' ? next.heightAt : null,
      heightReadAt: -Infinity,
      center: fromDegrees(
        next.lon,
        next.lat,
        groundHeightOk(next.heightM) ? next.heightM : 0,
      ),
      radiusM: next.radiusM,
      color: next.color || 'rgb(255,165,0)',
      shape: earthquakeContourShape(next.id),
      rgba: cssWithAlpha(next.color || 'rgb(255,165,0)'),
      // Angle 0 is north and a quarter turn is east (see `offsets`).
      north: { x: offsets[0], y: offsets[1], z: offsets[2] },
      east: {
        x: offsets[(RIPPLE_RING_SEGMENTS / 4) * 3],
        y: offsets[(RIPPLE_RING_SEGMENTS / 4) * 3 + 1],
        z: offsets[(RIPPLE_RING_SEGMENTS / 4) * 3 + 2],
      },
    };
    if (restart || !sameQuake) {
      startedAt = now();
      settlesAt =
        startedAt + RIPPLE_ACTIVE_CYCLES * EARTHQUAKE_RIPPLE_PERIOD_MS;
      // Assume it is in view until a paint says otherwise.
      onScreen = true;
    }
    lane ??= registerLane(RIPPLE_PAINT_LANE, paint, {
      id: 'earthquake-ripples',
    });
    lane.setActive(true);
    lane.requestPaint();
    // A refresh while the disc is out of sight asks for no frame; a paint
    // that finds it on screen again starts them (a restart sets onScreen).
    if (running() && onScreen && frameHandle === null)
      frameHandle = requestFrame(tick);
  }

  function hide() {
    stopFrames();
    if (!target) return;
    target = null;
    lane?.setActive(false);
  }

  function dispose() {
    hide();
    lane?.unregister();
    lane = null;
  }

  return { show, hide, dispose };
}
