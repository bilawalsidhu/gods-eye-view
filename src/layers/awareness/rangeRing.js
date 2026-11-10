/**
 * @module layers/awareness/rangeRing
 * @description The Global Context range ring and its sonar pulses, drawn
 * through the renderer's draw port. The ring is a haloed line (a solid line
 * with an outline) 2.5 km above the ellipsoid. While pulses run, each pulse
 * front is a haloed line whose positions move each step: every
 * `CYBER_SONAR_RENDER_INTERVAL_MS` on a parked view, every frame the camera
 * moves in. The band behind the fronts is one flat ellipse at the same
 * height filled with a canvas painted anew at most every interval (a new
 * key for new content). Nothing here is
 * pickable, so a click or tap near the ring reaches the contact underneath.
 * Under reduced motion, or where the renderer has no frame hooks, the ring
 * alone is drawn and stays.
 */
import { CYBER_SONAR_RENDER_INTERVAL_MS } from '../../cyberSonar.js';
import { AWARENESS_RADIUS_M } from '../../data/militaryAwarenessEngine.js';
import {
  AWARENESS_RANGE_ECHO,
  AWARENESS_RANGE_PULSE,
  AWARENESS_RANGE_RING_STYLE,
  CONTEXT_RIM_HEIGHT_M,
} from './policy.js';
import {
  awarenessEchoStrength,
  clearAwarenessEchoField,
  setAwarenessEchoField,
} from '../../awarenessEcho.js';
import { WGS84, fromRadians, toLonLatH } from '../../geo/ellipsoid.js';
import { distance, sub } from '../../geo/vector.js';
import { drawOf, findCamera, findFrame } from '../../render/rendererOf.js';

/**
 * A closed ring of positions `radiusM` along the surface from `groundCenter`,
 * raised to `heightM`. Each bearing steps over a sphere with the ellipsoid's
 * radius of curvature in that direction (Euler's formula), which keeps the
 * ring within ~50 m of the true geodesic radius at 250 km.
 * @param {{x: number, y: number, z: number}} groundCenter Ring centre on the ellipsoid.
 * @param {number} radiusM Surface radius in metres.
 * @param {number} heightM Height of the ring above the ellipsoid.
 * @param {number} [segments] Chords around the ring.
 * @returns {{x: number, y: number, z: number}[]} `segments + 1` positions;
 *   the last repeats the first.
 */
export function awarenessRangeRingPositions(
  groundCenter,
  radiusM,
  heightM,
  segments = AWARENESS_RANGE_RING_STYLE.segments,
) {
  const { lon, lat } = toLonLatH(groundCenter);
  const latitude = (lat * Math.PI) / 180;
  const longitude = (lon * Math.PI) / 180;
  const { x: a, z: b } = WGS84.radii;
  const e2 = 1 - (b * b) / (a * a);
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinLon = Math.sin(longitude);
  const cosLon = Math.cos(longitude);
  const w = 1 - e2 * sinLat * sinLat;
  const meridional = (a * (1 - e2)) / (w * Math.sqrt(w));
  const primeVertical = a / Math.sqrt(w);
  // Step along the great circle in 3D from the centre's up, north and east
  // unit vectors. Unlike the latitude/longitude destination formula, this
  // stays well conditioned at and next to the poles.
  const up = [cosLat * cosLon, cosLat * sinLon, sinLat];
  const north = [-sinLat * cosLon, -sinLat * sinLon, cosLat];
  const east = [-sinLon, cosLon, 0];
  const positions = [];
  for (let i = 0; i <= segments; i++) {
    const bearing = ((i % segments) / segments) * 2 * Math.PI;
    const cosB = Math.cos(bearing);
    const sinB = Math.sin(bearing);
    const angular =
      radiusM * ((cosB * cosB) / meridional + (sinB * sinB) / primeVertical);
    const cosA = Math.cos(angular);
    const sinA = Math.sin(angular);
    const [x, y, z] = up.map(
      (u, k) => u * cosA + (north[k] * cosB + east[k] * sinB) * sinA,
    );
    positions.push(
      fromRadians(Math.atan2(y, x), Math.atan2(z, Math.hypot(x, y)), heightM),
    );
  }
  return positions;
}

/**
 * Where pulse `index` is at `nowMs`: its radius and opacity. Pulses travel at
 * constant speed from `startFraction` of the range to the full range, fade in
 * over `fadeInFraction` of the way, then fade as (1 - travel) to the
 * `fadeOutPower` down to `endOpacityFraction` of the peak, so each is dim
 * but still visible when it reaches the range ring. The opacity already
 * includes `peakOpacity`.
 * @param {number} nowMs Monotonic clock in milliseconds.
 * @param {number} index Pulse number, 0 to `count - 1`.
 * @param {number} [radiusM] Range the pulses grow to.
 * @param {object} [pulse] Timing and shape, see `AWARENESS_RANGE_PULSE`.
 * @returns {{radiusM: number, alpha: number}}
 */
export function awarenessPulseState(
  nowMs,
  index,
  radiusM = AWARENESS_RADIUS_M,
  pulse = AWARENESS_RANGE_PULSE,
) {
  const cycle = nowMs / pulse.periodMs + index / pulse.count;
  const phase = cycle - Math.floor(cycle);
  return {
    radiusM:
      radiusM * (pulse.startFraction + (1 - pulse.startFraction) * phase),
    alpha:
      pulse.peakOpacity *
      Math.min(1, phase / pulse.fadeInFraction) *
      (pulse.endOpacityFraction +
        (1 - pulse.endOpacityFraction) * (1 - phase) ** pulse.fadeOutPower),
  };
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Whether the viewer asked the system for less motion. */
function prefersReducedMotion() {
  return globalThis.matchMedia?.(REDUCED_MOTION_QUERY)?.matches ?? false;
}

/**
 * How far the pulses are switched on at `nowMs`: 0 at rest, rising to 1 over
 * `settleMs` from `wake.startMs` and falling back to 0 over `settleMs` up to
 * `wake.untilMs`.
 * @param {number} nowMs Monotonic clock in milliseconds.
 * @param {{startMs: number, untilMs: number}} wake Window from `wakeAwarenessPulses`.
 * @param {object} [pulse] Timing, see `AWARENESS_RANGE_PULSE`.
 * @returns {number} 0 to 1.
 */
export function awarenessPulseLevel(
  nowMs,
  wake,
  pulse = AWARENESS_RANGE_PULSE,
) {
  const level = Math.min(
    (nowMs - wake.startMs) / pulse.settleMs,
    (wake.untilMs - nowMs) / pulse.settleMs,
  );
  return Math.max(0, Math.min(1, level));
}

/**
 * Run the pulses for `activeMs` from `nowMs`. A wake while they already run
 * keeps their current level, so they never jump back to full mid-fade.
 * @param {{startMs: number, untilMs: number}} wake Updated in place.
 * @param {number} nowMs Monotonic clock in milliseconds.
 * @param {object} [pulse] Timing, see `AWARENESS_RANGE_PULSE`.
 * @returns {{startMs: number, untilMs: number}} `wake`.
 */
export function wakeAwarenessPulses(
  wake,
  nowMs,
  pulse = AWARENESS_RANGE_PULSE,
) {
  wake.startMs =
    nowMs - awarenessPulseLevel(nowMs, wake, pulse) * pulse.settleMs;
  wake.untilMs = nowMs + pulse.activeMs;
  return wake;
}

/**
 * How strongly the 250 km ring shows at `nowMs` while pulses run: 1 as a
 * pulse front reaches it, fading over `flashMs`, so the ring appears once
 * per arriving pulse instead of standing on screen.
 * @param {number} nowMs Monotonic clock in milliseconds.
 * @returns {number} 0 to 1.
 */
export function awarenessRingFlash(nowMs) {
  return awarenessEchoStrength(
    nowMs,
    AWARENESS_RADIUS_M,
    AWARENESS_RADIUS_M,
    AWARENESS_RANGE_PULSE,
    { fadeMs: AWARENESS_RANGE_RING_STYLE.flashMs },
  );
}

/** `rgba(r, g, b, a)` as a draw-port colour, channels 0 to 1. */
function rgba(css) {
  const [r, g, b, a = 1] = css.match(/[\d.]+/g).map(Number);
  return [r / 255, g / 255, b / 255, a];
}

/** A colour with its alpha scaled by `alpha`. */
const faded = ([r, g, b, a], alpha) => [r, g, b, a * alpha];

/**
 * A haloed line as the draw port draws it: `widthPx` wide, its outer
 * `haloPx` on each side in the halo's colour, the rest in the core's.
 * @returns {object} The line item.
 */
const haloedLine = (id, positions, { core, halo, widthPx, haloPx, show }) => ({
  id,
  positions,
  widthPx,
  mode: '3d',
  style: {
    kind: 'solid',
    color: core,
    outline: { color: halo, widthPx: haloPx },
  },
  show,
});

/** Side of the band's canvas, pixels: the band is soft, 2 km a pixel. */
export const AWARENESS_BAND_PIXELS = 256;

/**
 * The band behind the pulse fronts into `image` (an `ImageData` of
 * `size × size`): at each pixel, a fraction `r` of `rangeM` from the
 * subject, the sum over pulses of `alpha × t²` where the pulse's front is
 * within `gradientDepthFraction` of the range outside it (`t` is 1 at the
 * front, 0 that far inward), times `gradientOpacity`, in `rgb`. The canvas
 * spans `spanM` either side of its centre; the subject is `offset` metres
 * east and north of that centre.
 * @param {{data: Uint8ClampedArray, width: number}} image
 * @param {{radii: number[], alphas: number[], rgb: number[], spanM: number,
 *   rangeM: number, offset: {east: number, north: number}, pulse?: object}} band
 */
export function paintAwarenessBand(image, band) {
  const { radii, alphas, rgb, spanM, rangeM, offset } = band;
  const pulse = band.pulse ?? AWARENESS_RANGE_PULSE;
  const size = image.width;
  const data = image.data;
  const depth = pulse.gradientDepthFraction;
  const [r, g, b] = rgb.map((c) => Math.round(c * 255));
  const perPixel = (2 * spanM) / size / rangeM;
  const cx = size / 2 + offset.east / ((2 * spanM) / size);
  // Canvas rows run north to south.
  const cy = size / 2 - offset.north / ((2 * spanM) / size);
  // The band depends on the distance from the subject alone: its alpha
  // byte is tabulated once along the radius, finer than a pixel, and each
  // pixel looks it up.
  const opacity = pulse.gradientOpacity;
  let outer = 0;
  for (const radius of radii) outer = Math.max(outer, radius);
  const bins = 4 * size;
  const table = new Uint8Array(bins + 1);
  for (let bin = 0; bin <= bins; bin++) {
    const at = (bin / bins) * outer;
    let sum = 0;
    for (let i = 0; i < radii.length; i++) {
      const inside = radii[i] - at;
      if (inside >= 0 && inside <= depth) {
        const t = 1 - inside / depth;
        sum += alphas[i] * t * t;
      }
    }
    // `Math.round` of a non-negative value.
    table[bin] = (Math.min(1, sum * opacity) * 255 + 0.5) | 0;
  }
  const toBin = outer > 0 ? bins / outer : 0;
  for (let y = 0; y < size; y++) {
    const dy = (y + 0.5 - cy) * perPixel;
    const dy2 = dy * dy;
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - cx) * perPixel;
      const at = Math.sqrt(dx * dx + dy2);
      const k = (y * size + x) * 4;
      data[k] = r;
      data[k + 1] = g;
      data[k + 2] = b;
      data[k + 3] = at > outer ? 0 : table[(at * toBin + 0.5) | 0];
    }
  }
}

/** `p` in metres east and north of `origin`, in `origin`'s surface frame. */
function eastNorth(origin, p) {
  const { lon, lat } = toLonLatH(origin);
  const l = (lon * Math.PI) / 180;
  const f = (lat * Math.PI) / 180;
  const d = sub(p, origin);
  return {
    east: -Math.sin(l) * d.x + Math.cos(l) * d.y,
    north:
      -Math.sin(f) * Math.cos(l) * d.x -
      Math.sin(f) * Math.sin(l) * d.y +
      Math.cos(f) * d.z,
  };
}

/** Camera height above the ellipsoid, or NaN when the renderer cannot say. */
function cameraHeightM(viewer) {
  return findCamera(viewer)?.pose()?.height ?? Number.NaN;
}

/** Each instance's set ids are its own. */
let instances = 0;

/**
 * The range ring and pulses of one awareness layer.
 * `layerState.visual` is what is drawn now, or null.
 * @param {object} options
 * @param {object} options.state
 * @param {(reason: string) => void} options.governorRequestRender
 * @param {(subject: object) => void} options.redraw Draws the subject's
 *   ring again (a reduced-motion change).
 */
export function createRangeRing({
  state: layerState,
  governorRequestRender,
  redraw,
}) {
  const instance = ++instances;
  /** The lines (ring and fronts) and the band's sets, on the viewer they draw on. */
  let sets = null;

  function setsOn(viewer) {
    if (sets?.viewer === viewer) return sets;
    disposeSets();
    const draw = drawOf(viewer);
    sets = {
      viewer,
      lines: draw.lines({
        id: `awareness:${instance}:rim`,
        pickable: false,
      }),
      band: draw.shapes({
        id: `awareness:${instance}:band`,
        pickable: false,
      }),
    };
    return sets;
  }

  function disposeSets() {
    sets?.lines.dispose();
    sets?.band.dispose();
    sets = null;
  }

  /**
   * Run the range pulses again for `activeMs`, after a camera move. Call it
   * during a frame (lifecycle's preRender): that frame's postRender arms the
   * next request, so waking asks for no extra frame of its own.
   */
  function wakePulses() {
    const visual = layerState.visual;
    if (!visual?.wake) return;
    wakeAwarenessPulses(visual.wake, performance.now());
    visual.step(performance.now());
  }

  function clearVisual() {
    const visual = layerState.visual;
    if (!visual) return;
    visual.stopPulses?.();
    visual.removeMotionListener?.();
    if (sets) {
      sets.lines.clear();
      sets.band.clear();
    }
    // Idle mode renders only on request; a removed ring must not linger.
    governorRequestRender('awareness-visual');
    clearAwarenessEchoField();
    layerState.visual = null;
  }

  /** Let go of the sets too, as the layer goes. */
  function disposeVisual() {
    clearVisual();
    disposeSets();
  }

  function renderVisual(subject) {
    const viewer = layerState.viewer;
    if (!viewer || !subject?.position) return;
    const location = toLonLatH(subject.position);
    if (!location) return;
    const groundCenter = fromRadians(
      (location.lon * Math.PI) / 180,
      (location.lat * Math.PI) / 180,
      0,
    );
    const key = `${subject.layerId}:${subject.id}`;
    const reducedMotion = prefersReducedMotion();
    const visual = layerState.visual;
    // A reduced-motion change rebuilds the visual, with or without pulses;
    // so does a ring drawn on another viewer (the layer re-initialized).
    if (
      visual?.key === key &&
      visual.viewer === viewer &&
      visual.reducedMotion === reducedMotion
    ) {
      // Move the ring only after a meaningful displacement so live tracking
      // does not redraw it for sub-pixel motion every 750 ms.
      if (distance(visual.center, groundCenter) >= 250) {
        // The echo field reads `visual.center` in place and follows on its
        // own.
        Object.assign(visual.center, groundCenter);
        visual.ringPositions = awarenessRangeRingPositions(
          groundCenter,
          AWARENESS_RADIUS_M,
          CONTEXT_RIM_HEIGHT_M,
        );
        visual.step(performance.now());
        // Content actually changed — buy exactly one frame instead of holding.
        governorRequestRender('awareness-visual');
      }
      return;
    }
    clearVisual();
    const { lines, band } = setsOn(viewer);
    const frame = findFrame(viewer);
    // A renderer without frame hooks gets the static ring only, as the
    // Cyber sonar scene does. So does a viewer who prefers reduced motion.
    const animate = Boolean(!reducedMotion && frame?.on);
    // Pulses run from now until `wake.untilMs`, then rest.
    const wake = animate
      ? wakeAwarenessPulses(
          { startMs: -Infinity, untilMs: -Infinity },
          performance.now(),
        )
      : null;
    // From a camera below the rim height the band would sweep across the
    // sky, so the pulses are hidden there and rest with it: no flash, no
    // echoes, no frames.
    const belowRim = () => cameraHeightM(viewer) < CONTEXT_RIM_HEIGHT_M;
    // One step asks for the level at one time several times over; the
    // camera's pose is read once for them.
    let levelMemo = { nowMs: NaN, startMs: NaN, untilMs: NaN, level: 0 };
    const levelAt = (nowMs) => {
      if (!wake) return 0;
      const memo = levelMemo;
      if (
        memo.nowMs === nowMs &&
        memo.startMs === wake.startMs &&
        memo.untilMs === wake.untilMs
      )
        return memo.level;
      const level = belowRim() ? 0 : awarenessPulseLevel(nowMs, wake);
      levelMemo = {
        nowMs,
        startMs: wake.startMs,
        untilMs: wake.untilMs,
        level,
      };
      return level;
    };

    const ring = AWARENESS_RANGE_RING_STYLE;
    const pulse = AWARENESS_RANGE_PULSE;
    const core = rgba(ring.color);
    const halo = rgba(ring.outlineColor);
    // While pulses run, the ring flashes as each one arrives and otherwise
    // dims to `restOpacity`; as they settle it returns to full and stays.
    const ringAlpha = (nowMs) => {
      const pulsed = Math.max(ring.restOpacity, awarenessRingFlash(nowMs));
      return 1 - levelAt(nowMs) * (1 - pulsed);
    };
    const center = { ...groundCenter };
    const next = {
      key,
      viewer,
      center,
      ringPositions: awarenessRangeRingPositions(
        groundCenter,
        AWARENESS_RADIUS_M,
        CONTEXT_RIM_HEIGHT_M,
      ),
      reducedMotion,
      wake,
      stopPulses: null,
      removeMotionListener: null,
      step: () => {},
      /** When the pulses were last drawn as they were then. */
      lastStepMs: Number.NEGATIVE_INFINITY,
    };

    /** The ring at `alpha` of its colours. */
    const ringItems = (alpha) => [
      haloedLine('ring', next.ringPositions, {
        core: faded(core, alpha),
        halo: faded(halo, alpha),
        widthPx: ring.width,
        haloPx: ring.outlineWidth,
        show: true,
      }),
    ];

    if (!animate) {
      lines.set(ringItems(1));
      next.step = () => lines.upsert(ringItems(1));
    } else {
      const count = pulse.count;
      // The band's ellipse is built around `bandCenter` and stands until
      // the subject has moved `gradientRebuildM` from it; meanwhile the
      // canvas draws the band about the subject, inside a margin as wide.
      const spanM = AWARENESS_RADIUS_M + pulse.gradientRebuildM;
      let bandCenter = null;
      let bandShown = null;
      // Two canvases in turn: a new key draws new content, and a renderer
      // that holds a canvas until its next frame never sees it rewritten.
      const doc = globalThis.document;
      const canvases = [0, 1].map(() => {
        const canvas = doc?.createElement?.('canvas');
        if (!canvas?.getContext) return null;
        canvas.width = canvas.height = AWARENESS_BAND_PIXELS;
        const context = canvas.getContext('2d');
        if (!context) return null;
        return {
          canvas,
          context,
          image: context.createImageData(
            AWARENESS_BAND_PIXELS,
            AWARENESS_BAND_PIXELS,
          ),
        };
      });
      const paints = canvases.every(Boolean);
      let painted = 0;
      let paintedMs = Number.NEGATIVE_INFINITY;

      // The image last drawn: a resting band keeps it, hidden, so showing
      // it again changes it in place.
      let image = null;
      const bandItem = (show) => {
        const { lon, lat } = toLonLatH(bandCenter);
        return {
          id: 'band',
          geometry: {
            kind: 'ellipse',
            center: { lon, lat, height: CONTEXT_RIM_HEIGHT_M },
            semiMajor: spanM,
            semiMinor: spanM,
          },
          height: 'absolute',
          fill: { image },
          show,
        };
      };

      /**
       * Draw the pulses as they are at `nowMs`, and the ring where it now
       * is: the fronts, the band and the ring's flash.
       */
      next.step = (nowMs) => {
        const level = levelAt(nowMs);
        const items = ringItems(ringAlpha(nowMs));
        const radii = [];
        const alphas = [];
        for (let index = 0; index < count; index++) {
          const state = awarenessPulseState(nowMs, index);
          radii.push(state.radiusM / AWARENESS_RADIUS_M);
          alphas.push(state.alpha * level);
          const front =
            level > 0
              ? awarenessRangeRingPositions(
                  center,
                  state.radiusM,
                  CONTEXT_RIM_HEIGHT_M,
                )
              : next.ringPositions;
          items.push(
            haloedLine(`pulse:${index}`, front, {
              core: faded(core, state.alpha * level),
              halo: faded(halo, state.alpha * level),
              widthPx: pulse.width,
              // The fronts' `outlineWidth` is both sides together.
              haloPx: pulse.outlineWidth / 2,
              show: level > 0,
            }),
          );
        }
        lines.upsert(items);
        if (!paints) return;
        const show = level > 0;
        // A resting band stays where it was built, and catches up on wake.
        const rebuilt =
          show &&
          (!bandCenter ||
            distance(bandCenter, center) >= pulse.gradientRebuildM);
        if (rebuilt) bandCenter = { ...center };
        if (!bandCenter) return;
        if (!show) {
          if (bandShown) band.upsert([bandItem(false)]);
          bandShown = false;
          return;
        }
        // The soft band is painted at most once a Cyber sonar interval;
        // the fronts, crisp lines, move on every step.
        if (
          bandShown &&
          !rebuilt &&
          nowMs - paintedMs < CYBER_SONAR_RENDER_INTERVAL_MS
        )
          return;
        paintedMs = nowMs;
        const target = canvases[painted % 2];
        paintAwarenessBand(target.image, {
          radii,
          alphas,
          rgb: core,
          spanM,
          rangeM: AWARENESS_RADIUS_M,
          offset: eastNorth(bandCenter, center),
        });
        target.context.putImageData(target.image, 0, 0);
        painted += 1;
        image = {
          canvas: target.canvas,
          key: `awareness-band:${instance}:${painted}`,
        };
        band.upsert([bandItem(true)]);
        bandShown = true;
      };

      lines.set(ringItems(1));
      /** Draw the pulses at `nowMs` while they run or settle. */
      const stepRunning = (nowMs) => {
        if (levelAt(nowMs) > 0 || bandShown || ringAlpha(nowMs) < 1) {
          next.lastStepMs = nowMs;
          next.step(nowMs);
        }
      };
      // The eye as the pulses were last drawn under it, to tell frames the
      // camera moved in from frames the pulses themselves asked for.
      const camera = findCamera(viewer);
      let lastEye = '';
      const eyeMoved = () => {
        const pose = camera?.pose();
        if (!pose) return false;
        const { position: p, direction: d } = pose;
        const eye = `${p.x},${p.y},${p.z},${d.x},${d.y},${d.z}`;
        if (eye === lastEye) return false;
        lastEye = eye;
        return true;
      };
      next.lastStepMs = performance.now();
      next.step(next.lastStepMs);
      // Each frame drawn while the camera moves, or held drawing, or at
      // least a Cyber sonar interval after the last step, steps them. A
      // step asks for the frame that draws it, which is no reason to step
      // again: a parked view, held by nothing, draws one frame each
      // interval, as the timer below asks.
      const offPreRender = frame.on('preRender', () => {
        const nowMs = performance.now();
        const moved = eyeMoved();
        if (
          moved ||
          frame.diagnostics?.()?.holds?.length > 0 ||
          nowMs - next.lastStepMs >= CYBER_SONAR_RENDER_INTERVAL_MS
        )
          stepRunning(nowMs);
      });
      // Each drawn frame, whoever asked for it, arms one step a Cyber
      // sonar interval later, as the Cyber sonar scene does, whose changes
      // ask for the frame that draws them. Requests never land within
      // 80 ms of a frame, so they cannot beat the detection lane's 80 ms
      // gate, and they stop once the pulses rest.
      let timer = null;
      const offPostRender = frame.on('postRender', () => {
        globalThis.clearTimeout(timer);
        timer = null;
        const nowMs = performance.now();
        if ((nowMs < wake.untilMs || bandShown) && !belowRim())
          timer = globalThis.setTimeout(() => {
            timer = null;
            stepRunning(performance.now());
            governorRequestRender('awareness-pulse');
          }, CYBER_SONAR_RENDER_INTERVAL_MS);
      });
      next.stopPulses = () => {
        offPreRender();
        offPostRender();
        globalThis.clearTimeout(timer);
        timer = null;
      };
      // The detection overlay pulses the brackets of flights and vessels a
      // front crosses; it reads the centre in place, so it follows too.
      setAwarenessEchoField({
        center,
        radiusM: AWARENESS_RADIUS_M,
        pulse,
        echo: AWARENESS_RANGE_ECHO,
        level: levelAt,
      });
    }

    // Turning reduced motion on or off mid-session rebuilds the visual.
    const motionQuery = globalThis.matchMedia?.(REDUCED_MOTION_QUERY);
    const onMotionChange = () => {
      if (layerState.subject) redraw(layerState.subject);
    };
    // Safari before 14 has only the older addListener / removeListener.
    if (motionQuery?.addEventListener)
      motionQuery.addEventListener('change', onMotionChange);
    else motionQuery?.addListener?.(onMotionChange);
    next.removeMotionListener = () => {
      if (motionQuery?.removeEventListener)
        motionQuery.removeEventListener('change', onMotionChange);
      else motionQuery?.removeListener?.(onMotionChange);
    };

    layerState.visual = next;
    governorRequestRender('awareness-visual');
  }
  return { renderVisual, clearVisual, disposeVisual, wakePulses };
}
