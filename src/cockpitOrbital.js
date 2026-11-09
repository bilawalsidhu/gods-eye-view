/**
 * Camera policy for the orbital (satellite) view: the eye rides the tracked
 * satellite and looks straight down at the Earth's centre. Satellites publish
 * no attitude, so the picture is turned to the ground track (track-up; see
 * nadirOrientation's `headingDeg`), or north-up for a satellite with none
 * (geostationary). This module holds the zoom steps,
 * the field of view, the nadir orientation, the ground footprint and the zoom
 * transition curves. No DOM, Cesium or i18n dependencies: vectors are plain
 * `{x, y, z}` objects in Earth-fixed (ECEF) metres, so the policy is
 * unit-testable and the Cockpit camera copies them into its own scratch.
 */

/** Mean Earth radius used for footprint and framing geometry, metres. */
export const ORBITAL_EARTH_RADIUS_M = 6371008.8;

/**
 * The whole zoom ladder. Steps past ORBITAL_BASE_MAX_ZOOM belong only to
 * imaging satellites with a known sensor, each up to the step its sensor's
 * swath allows (`orbitalMaxZoom`).
 */
export const ORBITAL_ZOOM_LADDER = Object.freeze([1, 2, 4, 8, 16, 32, 64, 128]);

/** The tightest step for a satellite without sensor data. */
export const ORBITAL_BASE_MAX_ZOOM = 8;

/** The zoom an orbital view opens at. */
export const ORBITAL_DEFAULT_ZOOM = 1;

/**
 * Vertical field of view at 1x for low orbits. From the ISS (~420 km) a 60°
 * frame spans roughly 490 km of ground top to bottom: a regional picture
 * with the curvature just out of frame, which 8x narrows to ~60 km.
 */
export const ORBITAL_BASE_FOV_LEO_RAD = (60 * Math.PI) / 180;

/**
 * How much wider than the Earth's disk a high orbit's 1x frame is. A fixed
 * 60° frame from GEO (~35,786 km) would show a 17° Earth floating in black;
 * above about 8,000 km the base frame instead fits the whole disk with this
 * margin, so 1x is "the whole Earth" and the steps zoom into it.
 */
export const ORBITAL_DISK_MARGIN = 1.15;

/** Duration of one zoom step's field-of-view change, ms. */
export const ORBITAL_ZOOM_TRANSITION_MS = 400;

/** How long the reticle shows its lock tick after a step settles, ms. */
export const ORBITAL_LOCK_TICK_MS = 220;

/** Peak focus-pull blur at the middle of a zoom step, CSS pixels. */
export const ORBITAL_MAX_BLUR_PX = 6;

/**
 * Longest a zoom step holds its focus pull for the new field of view's
 * imagery, ms. The camera moves at orbital speed, so the tiles may never
 * all arrive; the hold gives them a start, then the reticle locks anyway.
 */
export const ORBITAL_SETTLE_MAX_MS = 2500;

/** The soft blur held while a step waits for its imagery, CSS pixels. */
export const ORBITAL_SETTLE_BLUR_PX = 2.5;

/** Relative slack so a zoom computed in floating point still meets its step. */
const ZOOM_EPSILON = 1e-6;

/**
 * The next tighter ladder step, up to `maxZoom`; at the cap the zoom stays.
 * A zoom between steps (the SENSOR step) moves to the step above it.
 * @param {number} zoom Current zoom.
 * @param {number} [maxZoom] The satellite's tightest step.
 * @returns {number}
 */
export function nextOrbitalZoom(zoom, maxZoom = ORBITAL_BASE_MAX_ZOOM) {
  const current = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const next = ORBITAL_ZOOM_LADDER.find(
    (step) => step > current * (1 + ZOOM_EPSILON) && step <= maxZoom,
  );
  return next ?? current;
}

/**
 * The next wider ladder step; 1x stays where it is. A zoom between steps
 * moves to the step below it.
 * @param {number} zoom Current zoom.
 * @returns {number}
 */
export function previousOrbitalZoom(zoom) {
  const current = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const wider = ORBITAL_ZOOM_LADDER.filter(
    (step) => step < current * (1 - ZOOM_EPSILON),
  );
  return wider.length ? wider[wider.length - 1] : ORBITAL_DEFAULT_ZOOM;
}

/**
 * The ground width the view spans at a zoom: what the SWATH readout shows.
 * @param {number} altitudeM Satellite altitude, metres.
 * @param {number} zoom Magnification.
 * @param {number} aspect Canvas width / height.
 * @returns {number|null} Kilometres, or null for an unusable altitude.
 */
export function viewWidthKm(altitudeM, zoom, aspect) {
  return footprintWidthKm(
    altitudeM,
    fovForZoom(orbitalBaseFovRad(altitudeM), zoom),
    aspect,
  );
}

/**
 * A satellite's tightest zoom step at its live altitude: the tightest ladder
 * step whose view is still at least as wide as its sensor's narrowest
 * standard swath, so the view never shows finer ground than the sensor
 * images. Never below ORBITAL_BASE_MAX_ZOOM; no sensor swath, no extra steps.
 * @param {number} altitudeM Live altitude, metres.
 * @param {number|null|undefined} sensorSwathKm Narrowest standard swath.
 * @param {number} aspect Canvas width / height.
 * @returns {number} One of ORBITAL_ZOOM_LADDER.
 */
export function orbitalMaxZoom(altitudeM, sensorSwathKm, aspect) {
  if (!Number.isFinite(sensorSwathKm) || sensorSwathKm <= 0)
    return ORBITAL_BASE_MAX_ZOOM;
  let max = ORBITAL_BASE_MAX_ZOOM;
  for (const step of ORBITAL_ZOOM_LADDER) {
    if (step <= ORBITAL_BASE_MAX_ZOOM) continue;
    const width = viewWidthKm(altitudeM, step, aspect);
    if (!Number.isFinite(width)) break;
    if (width * (1 + ZOOM_EPSILON) < sensorSwathKm) break;
    max = step;
  }
  return max;
}

/**
 * The zoom at which the view is exactly as wide as the sensor's swath, for
 * the SENSOR step; null when that lies outside 1x..`maxZoom` (a swath wider
 * than the 1x view, or narrower than the tightest allowed step).
 * @param {number} altitudeM Live altitude, metres.
 * @param {number|null|undefined} sensorSwathKm
 * @param {number} aspect Canvas width / height.
 * @param {number} maxZoom The satellite's tightest step.
 * @returns {number|null}
 */
export function sensorSwathZoom(altitudeM, sensorSwathKm, aspect, maxZoom) {
  if (!Number.isFinite(sensorSwathKm) || sensorSwathKm <= 0) return null;
  const widest = viewWidthKm(altitudeM, 1, aspect);
  const tightest = viewWidthKm(altitudeM, maxZoom, aspect);
  if (!Number.isFinite(widest) || !Number.isFinite(tightest)) return null;
  if (sensorSwathKm > widest * (1 + ZOOM_EPSILON)) return null;
  if (sensorSwathKm < tightest * (1 - ZOOM_EPSILON)) return null;
  // The width falls monotonically with zoom: bisect in log space.
  let low = 0;
  let high = Math.log2(maxZoom);
  for (let i = 0; i < 48; i += 1) {
    const mid = (low + high) / 2;
    if (viewWidthKm(altitudeM, 2 ** mid, aspect) > sensorSwathKm) low = mid;
    else high = mid;
  }
  return Math.round(2 ** ((low + high) / 2) * 100) / 100;
}

/**
 * How much of the view's width a sensor swath covers, for the strip drawn
 * to scale in the reticle: 0..1, 1 when the swath fills the view or more.
 * @param {number|null|undefined} sensorSwathKm
 * @param {number|null|undefined} viewKm The view's current ground width.
 * @returns {number|null} Null without both widths.
 */
export function sensorStripFraction(sensorSwathKm, viewKm) {
  if (!Number.isFinite(sensorSwathKm) || sensorSwathKm <= 0) return null;
  if (!Number.isFinite(viewKm) || viewKm <= 0) return null;
  return Math.min(1, sensorSwathKm / viewKm);
}

/**
 * Angular radius of the Earth's disk seen from an altitude, radians.
 * @param {number} altitudeM Height above the mean sphere, metres.
 * @returns {number} Half-angle from nadir to the limb (π/2 at the surface).
 */
export function earthAngularRadiusRad(altitudeM) {
  const h = Math.max(0, Number.isFinite(altitudeM) ? altitudeM : 0);
  return Math.asin(ORBITAL_EARTH_RADIUS_M / (ORBITAL_EARTH_RADIUS_M + h));
}

/**
 * Vertical field of view at 1x for an altitude, radians.
 *
 * Low orbits get the fixed 60° regional frame. Higher orbits, where 60° would
 * leave the Earth small in a black frame, get the Earth's disk plus
 * ORBITAL_DISK_MARGIN. The two meet near 8,100 km, so the base never jumps
 * as an eccentric orbit climbs: GPS (~20,200 km) opens at ~32°, GEO at ~20°.
 * @param {number} altitudeM Satellite altitude, metres.
 * @returns {number} Vertical field of view, radians.
 */
export function orbitalBaseFovRad(altitudeM) {
  const diskFov = 2 * earthAngularRadiusRad(altitudeM) * ORBITAL_DISK_MARGIN;
  return Math.min(ORBITAL_BASE_FOV_LEO_RAD, diskFov);
}

/**
 * Field of view at an optical zoom: magnification divides the tangent of
 * the half-angle, as a lens's focal length does.
 * @param {number} baseFovRad Field of view at 1x, radians.
 * @param {number} zoom Magnification (1 leaves the base unchanged).
 * @returns {number} Field of view, radians.
 */
export function fovForZoom(baseFovRad, zoom) {
  const magnification = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return 2 * Math.atan(Math.tan(baseFovRad / 2) / magnification);
}

/**
 * Cesium's `PerspectiveFrustum.fov` is horizontal on a landscape canvas and
 * vertical on a portrait one; convert a vertical field of view to it.
 * @param {number} verticalFovRad Vertical field of view, radians.
 * @param {number} aspect Canvas width / height.
 * @returns {number} The value to assign to `frustum.fov`, radians.
 */
export function cesiumFrustumFovRad(verticalFovRad, aspect) {
  if (!(aspect > 1)) return verticalFovRad;
  return 2 * Math.atan(Math.tan(verticalFovRad / 2) * aspect);
}

/**
 * Ground width covered across the frame, along a great circle through the
 * sub-satellite point, km. A ray past the limb ends at the horizon, so a
 * frame wider than the disk reports the visible cap's width.
 * @param {number} altitudeM Satellite altitude, metres.
 * @param {number} fovRad Vertical field of view, radians.
 * @param {number} [aspect=1] Frame width / height; the width is measured
 *   across the wider horizontal extent.
 * @returns {number|null} Width in kilometres, or null without a usable input.
 */
export function footprintWidthKm(altitudeM, fovRad, aspect = 1) {
  if (!Number.isFinite(altitudeM) || altitudeM <= 0) return null;
  if (!Number.isFinite(fovRad) || fovRad <= 0) return null;
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const halfAngle = Math.atan(Math.tan(fovRad / 2) * ratio);
  const R = ORBITAL_EARTH_RADIUS_M;
  const sinGround = ((R + altitudeM) / R) * Math.sin(halfAngle);
  // Central angle from nadir to where the ray meets the sphere, or the limb.
  const central =
    sinGround >= 1
      ? Math.acos(R / (R + altitudeM))
      : Math.asin(sinGround) - halfAngle;
  return (2 * R * central) / 1000;
}

function length(v) {
  return Math.hypot(v.x, v.y, v.z);
}

function scale(v, s) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** `v` with its component along unit `d` removed, or null when degenerate. */
function perpendicularUnit(v, d) {
  const along = dot(v, d);
  const p = {
    x: v.x - along * d.x,
    y: v.y - along * d.y,
    z: v.z - along * d.z,
  };
  const n = length(p);
  return n > 1e-6 ? scale(p, 1 / n) : null;
}

const NORTH_AXIS = Object.freeze({ x: 0, y: 0, z: 1 });

/**
 * Camera orientation looking from an Earth-fixed position at the Earth's
 * centre, with north at the top of the frame.
 *
 * `up` is the Earth's rotation axis projected perpendicular to the view, which
 * is local north at the sub-satellite point. Directly over a pole north is
 * undefined; the previous frame's `up` is kept when given (so a polar pass
 * does not spin the picture), otherwise the limit along the prime meridian
 * is used: over the north pole the top of the frame faces 180°E, over the
 * south pole 0°E.
 *
 * With `headingDeg` the frame turns so that bearing (degrees clockwise from
 * north) is at the top: the ground track, for a view that scrolls along it.
 * @param {{x: number, y: number, z: number}} position ECEF position, metres.
 * @param {{previousUp?: {x: number, y: number, z: number}|null,
 *   headingDeg?: number|null}} [options] `previousUp` is a previous frame's
 *   `north`, not its turned `up`.
 * @returns {{direction: {x: number, y: number, z: number},
 *   up: {x: number, y: number, z: number},
 *   right: {x: number, y: number, z: number},
 *   north: {x: number, y: number, z: number}}|null} Unit vectors (right =
 *   direction × up, as Cesium's camera keeps them), or null at the centre.
 */
export function nadirOrientation(
  position,
  { previousUp = null, headingDeg = null } = {},
) {
  if (!position) return null;
  const r = length(position);
  if (!Number.isFinite(r) || r < 1) return null;
  const direction = scale(position, -1 / r);
  let up = perpendicularUnit(NORTH_AXIS, direction);
  if (!up && previousUp && Number.isFinite(length(previousUp)))
    up = perpendicularUnit(previousUp, direction);
  if (!up) {
    // Looking down -z (north pole): north at longitude 0 points along -x.
    up = perpendicularUnit(
      { x: direction.z < 0 ? -1 : 1, y: 0, z: 0 },
      direction,
    );
  }
  const north = up;
  if (Number.isFinite(headingDeg) && headingDeg % 360 !== 0) {
    // Looking down, right = direction × north is east: the bearing turns
    // north toward it.
    const east = cross(direction, north);
    const θ = (headingDeg * Math.PI) / 180;
    up = {
      x: north.x * Math.cos(θ) + east.x * Math.sin(θ),
      y: north.y * Math.cos(θ) + east.y * Math.sin(θ),
      z: north.z * Math.cos(θ) + east.z * Math.sin(θ),
    };
  }
  return { direction, up, right: cross(direction, up), north };
}

/**
 * Ease-in-out progress of a zoom step (cubic), clamped to 0..1.
 * @param {number} elapsedMs Time since the step began.
 * @param {{durationMs?: number, reducedMotion?: boolean}} [options]
 *   Reduced motion cuts straight to the end.
 * @returns {number} Eased progress, 0..1.
 */
export function zoomTransitionProgress(
  elapsedMs,
  { durationMs = ORBITAL_ZOOM_TRANSITION_MS, reducedMotion = false } = {},
) {
  if (reducedMotion || !(durationMs > 0)) return 1;
  const linear = Math.min(1, Math.max(0, (elapsedMs || 0) / durationMs));
  return linear < 0.5 ? 4 * linear ** 3 : 1 - (-2 * linear + 2) ** 3 / 2;
}

/**
 * Focus-pull blur for a zoom step: zero at both ends, peaking mid-step.
 * @param {number} progress Step progress, 0..1 (linear or eased).
 * @param {{maxBlurPx?: number, reducedMotion?: boolean}} [options]
 *   Reduced motion never blurs.
 * @returns {number} Blur radius, CSS pixels.
 */
export function zoomTransitionBlurPx(
  progress,
  { maxBlurPx = ORBITAL_MAX_BLUR_PX, reducedMotion = false } = {},
) {
  if (reducedMotion || !Number.isFinite(progress)) return 0;
  const p = Math.min(1, Math.max(0, progress));
  return Math.max(0, maxBlurPx) * Math.sin(Math.PI * p);
}

/**
 * Field of view part-way through a zoom step. Interpolates the tangent of
 * the half-angle geometrically, so each moment of the step magnifies by the
 * same ratio and 1x→2x feels like 4x→8x.
 * @param {number} fromFovRad Field of view the step starts at.
 * @param {number} toFovRad Field of view the step ends at.
 * @param {number} progress Eased progress, 0..1.
 * @returns {number} Field of view, radians.
 */
export function interpolateZoomFov(fromFovRad, toFovRad, progress) {
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 1));
  const a = Math.log(Math.tan(fromFovRad / 2));
  const b = Math.log(Math.tan(toFovRad / 2));
  return 2 * Math.atan(Math.exp(a + (b - a) * p));
}

/**
 * The HUD's transition state at a moment of a zoom step, in the store shape
 * `{ active, blurPx, lockTick }`: blur while the field of view moves, then a
 * brief reticle lock tick once it settles. Reduced motion skips the blur and
 * the tick (the cut is instant).
 * @param {number} elapsedMs Time since the step began.
 * @param {{durationMs?: number, lockTickMs?: number, maxBlurPx?: number,
 *   reducedMotion?: boolean}} [options]
 * @returns {{active: boolean, progress: number, blurPx: number,
 *   lockTick: boolean}}
 */
export function zoomTransitionState(
  elapsedMs,
  {
    durationMs = ORBITAL_ZOOM_TRANSITION_MS,
    lockTickMs = ORBITAL_LOCK_TICK_MS,
    maxBlurPx = ORBITAL_MAX_BLUR_PX,
    reducedMotion = false,
  } = {},
) {
  const progress = zoomTransitionProgress(elapsedMs, {
    durationMs,
    reducedMotion,
  });
  if (reducedMotion)
    return { active: false, progress: 1, blurPx: 0, lockTick: false };
  const elapsed = Math.max(0, elapsedMs || 0);
  const linear = durationMs > 0 ? Math.min(1, elapsed / durationMs) : 1;
  return {
    active: elapsed < durationMs,
    progress,
    blurPx: zoomTransitionBlurPx(linear, { maxBlurPx }),
    lockTick: elapsed >= durationMs && elapsed < durationMs + lockTickMs,
  };
}

/**
 * Whether a zoom step whose field of view has landed still holds its focus
 * pull: until the imagery has loaded, at most `maxHoldMs`.
 * @param {number} sinceLandedMs Time since the field of view stopped moving.
 * @param {boolean} tilesLoaded Whether the scene's imagery has loaded.
 * @param {{maxHoldMs?: number}} [options]
 */
export function zoomSettleHolding(
  sinceLandedMs,
  tilesLoaded,
  { maxHoldMs = ORBITAL_SETTLE_MAX_MS } = {},
) {
  return !tilesLoaded && Math.max(0, sinceLandedMs || 0) < maxHoldMs;
}

/**
 * The total angle between a tilted view and nadir, degrees:
 * acos(cos north · cos east), as `offNadirOrientation` tilts.
 * @param {{northDeg?: number, eastDeg?: number}} [offset] Tilt in degrees.
 * @returns {number}
 */
export function offNadirAngleDeg({ northDeg = 0, eastDeg = 0 } = {}) {
  const n = ((Number.isFinite(northDeg) ? northDeg : 0) * Math.PI) / 180;
  const e = ((Number.isFinite(eastDeg) ? eastDeg : 0) * Math.PI) / 180;
  const cosine = Math.min(1, Math.max(-1, Math.cos(n) * Math.cos(e)));
  return (Math.acos(cosine) * 180) / Math.PI;
}

/**
 * Whether the view's centre, tilted off nadir, still meets the Earth: its
 * angle from nadir (`offNadirAngleDeg`) is within the Earth's angular radius
 * from the satellite, asin(R / (R + altitude)).
 * @param {number} altitudeM
 * @param {{northDeg?: number, eastDeg?: number}} [offset]
 * @returns {boolean}
 */
export function offNadirCentreMeetsEarth(altitudeM, offset = {}) {
  if (!Number.isFinite(altitudeM) || altitudeM <= 0) return false;
  const R = ORBITAL_EARTH_RADIUS_M;
  const limbDeg = (Math.asin(R / (R + altitudeM)) * 180) / Math.PI;
  return offNadirAngleDeg(offset) < limbDeg;
}

/**
 * Roughly how much wider the ground across the frame is at the centre of a
 * tilted view than at nadir, on a flat Earth: tilting across the frame (east,
 * the frame's right) stretches its width by 1/cos², tilting along it (north,
 * the frame's top) by 1/cos. 1 at nadir; an approximation, so the HUD marks
 * the width it scales with ≈.
 * @param {{northDeg?: number, eastDeg?: number}} [offset] Tilt in degrees.
 * @returns {number} At least 1.
 */
export function offNadirSwathScale({ northDeg = 0, eastDeg = 0 } = {}) {
  const n = ((Number.isFinite(northDeg) ? northDeg : 0) * Math.PI) / 180;
  const e = ((Number.isFinite(eastDeg) ? eastDeg : 0) * Math.PI) / 180;
  const along = Math.abs(Math.cos(n));
  const across = Math.cos(e) ** 2;
  if (!(along > 1e-6) || !(across > 1e-6)) return 1;
  return Math.max(1, 1 / (along * across));
}

/**
 * Tilt a nadir orientation off nadir: first toward north (a rotation about
 * the nadir frame's right axis), then toward east (about the tilted up
 * axis). The base frame is always the nadir one, so a tilt never drifts with
 * the orbit; the angle from nadir is acos(cos north · cos east).
 * @param {{direction: object, up: object, right: object}} nadir From
 *   {@link nadirOrientation}.
 * @param {{northDeg?: number, eastDeg?: number}} [offset] Tilt in degrees;
 *   negative is south or west.
 * @returns {{direction: object, up: object, right: object}} Unit vectors,
 *   right = direction × up.
 */
export function offNadirOrientation(nadir, { northDeg = 0, eastDeg = 0 } = {}) {
  const n = ((Number.isFinite(northDeg) ? northDeg : 0) * Math.PI) / 180;
  const e = ((Number.isFinite(eastDeg) ? eastDeg : 0) * Math.PI) / 180;
  if (n === 0 && e === 0) return nadir;
  const { direction: d, up: u, right: r } = nadir;
  const combine = (a, ka, b, kb) => ({
    x: a.x * ka + b.x * kb,
    y: a.y * ka + b.y * kb,
    z: a.z * ka + b.z * kb,
  });
  // Toward north: the view swings onto the up axis, up swings off it.
  const d1 = combine(d, Math.cos(n), u, Math.sin(n));
  const u1 = combine(u, Math.cos(n), d, -Math.sin(n));
  // Toward east: the view swings onto the right axis.
  const direction = combine(d1, Math.cos(e), r, Math.sin(e));
  return { direction, up: u1, right: cross(direction, u1) };
}

/** Scroll distance, in pixels, that makes one zoom step. A mouse notch is ~100. */
export const ORBITAL_WHEEL_PIXELS_PER_STEP = 100;

/**
 * After a step, the rest of that gesture is absorbed for this long, so one
 * physical notch (which some browsers deliver as several events) is one step.
 */
export const ORBITAL_WHEEL_COOLDOWN_MS = 200;

/**
 * A pause this long ends a scroll gesture: a partial sum left from an earlier
 * gesture never adds to a later one.
 */
export const ORBITAL_WHEEL_GESTURE_GAP_MS = 300;

/** `WheelEvent.deltaMode` line and page units, in pixels. */
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 800;

/**
 * Turn wheel events into zoom steps. Trackpads send many small pixel deltas,
 * so they are summed until they reach a step; a change of direction, or a
 * pause of ORBITAL_WHEEL_GESTURE_GAP_MS, starts over. Wheeling away from the
 * viewer (negative deltaY) zooms in.
 * @param {{sum: number, lastStepMs: number, lastEventMs?: number}|null}
 *   accumulator Previous state.
 * @param {{deltaY: number, deltaMode?: number}} wheel The event's deltas.
 * @param {number} nowMs
 * @returns {{accumulator: {sum: number, lastStepMs: number,
 *   lastEventMs: number}, step: -1|0|1}} The new state and the step to take
 *   (1 = zoom in).
 */
export function wheelZoomStep(accumulator, wheel, nowMs) {
  const held = accumulator || { sum: 0, lastStepMs: -Infinity };
  const previous =
    nowMs - (held.lastEventMs ?? -Infinity) > ORBITAL_WHEEL_GESTURE_GAP_MS
      ? { ...held, sum: 0 }
      : held;
  const unit =
    wheel?.deltaMode === 1
      ? WHEEL_LINE_PX
      : wheel?.deltaMode === 2
        ? WHEEL_PAGE_PX
        : 1;
  const delta = (Number.isFinite(wheel?.deltaY) ? wheel.deltaY : 0) * unit;
  if (!delta) return { accumulator: held, step: 0 };
  if (nowMs - previous.lastStepMs < ORBITAL_WHEEL_COOLDOWN_MS)
    return {
      accumulator: { ...previous, sum: 0, lastEventMs: nowMs },
      step: 0,
    };
  const sum =
    Math.sign(previous.sum) === -Math.sign(delta)
      ? delta
      : previous.sum + delta;
  if (Math.abs(sum) < ORBITAL_WHEEL_PIXELS_PER_STEP)
    return { accumulator: { ...previous, sum, lastEventMs: nowMs }, step: 0 };
  return {
    accumulator: { sum: 0, lastStepMs: nowMs, lastEventMs: nowMs },
    step: sum < 0 ? 1 : -1,
  };
}

/** From this zoom the view pre-loads imagery ahead along the ground track. */
export const ORBITAL_PREFETCH_MIN_ZOOM = 16;

/** How often the pre-load looks ahead, ms. */
export const ORBITAL_PREFETCH_INTERVAL_MS = 2000;

/** How far ahead it looks, seconds of ground-track travel, nearest first. */
export const ORBITAL_PREFETCH_LEAD_S = Object.freeze([5, 10, 15, 20]);

/**
 * Where across the track it looks, as fractions of the view's width: the
 * centre line, a third out and the frame's edges each side, so a row of
 * tiles a fifth of the view wide or more spans the frame.
 */
export const ORBITAL_PREFETCH_ACROSS = Object.freeze([
  0,
  -1 / 3,
  1 / 3,
  -1 / 2,
  1 / 2,
]);

/**
 * The points ahead, regrouped by their place across the track: every lead's
 * centre point first, then each lead's next pair out, so the tile cap trims
 * the frame's edges before it trims the far leads.
 * @param {Array<{lat: number, lon: number}>} points From `groundTrackAhead`,
 *   lead by lead.
 * @param {number} [across] Points per lead.
 * @returns {Array<{lat: number, lon: number}>}
 */
export function centreLinesFirst(
  points,
  across = ORBITAL_PREFETCH_ACROSS.length,
) {
  const out = [];
  for (let k = 0; k < across; k += 1)
    for (let i = k; i < points.length; i += across) out.push(points[i]);
  return out;
}

/** At most this many tile requests per look-ahead. */
export const ORBITAL_PREFETCH_MAX_TILES = 12;

const toRadians = (deg) => (deg * Math.PI) / 180;
const toDegrees = (rad) => (rad * 180) / Math.PI;

/**
 * The point `distanceM` from a point along an initial bearing, on a sphere.
 * @returns {{lat: number, lon: number}} Degrees, longitude in -180..180.
 */
export function destinationPoint(latDeg, lonDeg, bearingDeg, distanceM) {
  const delta = distanceM / ORBITAL_EARTH_RADIUS_M;
  const lat1 = toRadians(latDeg);
  const theta = toRadians(bearingDeg);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(delta) +
      Math.cos(lat1) * Math.sin(delta) * Math.cos(theta),
  );
  const lon2 =
    toRadians(lonDeg) +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(lat1),
      Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2),
    );
  const lon = ((((toDegrees(lon2) + 180) % 360) + 360) % 360) - 180;
  return { lat: toDegrees(lat2), lon };
}

/**
 * Points the view will pass over: for each lead time, the sub-satellite
 * point that far along the ground track (orbital speed scaled down to the
 * ground), and points across the track at `across` fractions of the view's
 * width. Nearest lead first. Empty without a track, speed or width.
 * @param {{latitude: number, longitude: number, groundTrackDeg: number,
 *   velocityMps: number, altitudeM: number}} info Satellite subject.
 * @param {number} viewKm The view's ground width, km.
 * @returns {Array<{lat: number, lon: number}>}
 */
export function groundTrackAhead(
  info,
  viewKm,
  { leadS = ORBITAL_PREFETCH_LEAD_S, across = ORBITAL_PREFETCH_ACROSS } = {},
) {
  const { latitude, longitude, groundTrackDeg, velocityMps, altitudeM } =
    info || {};
  if (
    ![latitude, longitude, groundTrackDeg, velocityMps, altitudeM].every(
      Number.isFinite,
    ) ||
    velocityMps <= 0 ||
    altitudeM <= 0 ||
    !(viewKm > 0)
  )
    return [];
  const R = ORBITAL_EARTH_RADIUS_M;
  const groundMps = (velocityMps * R) / (R + altitudeM);
  const points = [];
  for (const seconds of leadS) {
    const centre = destinationPoint(
      latitude,
      longitude,
      groundTrackDeg,
      groundMps * seconds,
    );
    for (const fraction of across) {
      points.push(
        fraction === 0
          ? centre
          : destinationPoint(
              centre.lat,
              centre.lon,
              groundTrackDeg + (fraction > 0 ? 90 : -90),
              Math.abs(fraction) * viewKm * 1000,
            ),
      );
    }
  }
  return points;
}

/** WGS84's equatorial radius: Cesium sizes terrain and imagery tiles on it. */
const WGS84_MAXIMUM_RADIUS_M = 6378137;

/**
 * Cesium's geometric error for a heightmap terrain tile at `level`, metres:
 * its level-zero estimate (TerrainProvider's
 * getEstimatedLevelZeroGeometricErrorForAHeightmap, heightmap quality 0.25)
 * for the ellipsoid terrain's 64-sample tiles on two root tiles, halved per
 * level.
 * @param {number} level
 * @returns {number}
 */
export function ellipsoidTerrainLevelErrorM(level) {
  return (WGS84_MAXIMUM_RADIUS_M * 2 * Math.PI * 0.25) / (64 * 2) / 2 ** level;
}

/** The deepest terrain level considered. */
const MAX_TERRAIN_LEVEL = 30;

/**
 * The imagery level Cesium draws under the view, and so the one to pre-load.
 * Cesium refines the terrain tile under the view while its geometric error
 * spans more than `maximumScreenSpaceError` pixels (QuadtreePrimitive's
 * screenSpaceError: error over the ground a pixel covers), then drapes the
 * imagery level whose texel spacing is nearest that error (ImageryLayer's
 * getLevelWithMaximumTexelSpacing, rounded): about one to two screen pixels
 * per texel, not one. Fog, which below 800 km can only coarsen the choice,
 * is left out. Clamped to the provider's levels; null without a usable input.
 * @param {{getNumberOfXTilesAtLevel?: (level: number) => number,
 *   rectangle?: {width: number}}} tilingScheme The imagery tiling scheme.
 * @param {{metresPerPixel: number, latitudeDeg: number,
 *   geographic?: boolean, tileWidthPx?: number, minimumLevel?: number,
 *   maximumLevel?: number, maximumScreenSpaceError?: number,
 *   terrainLevelErrorM?: (level: number) => number}} view `metresPerPixel`
 *   is the ground one CSS pixel covers at the view's centre; `geographic`
 *   marks a scheme in the geographic projection, whose texels do not narrow
 *   with latitude as Web Mercator's do; `terrainLevelErrorM` is the terrain
 *   provider's getLevelMaximumGeometricError.
 * @returns {number|null}
 */
export function imageryLevelForView(
  tilingScheme,
  {
    metresPerPixel,
    latitudeDeg,
    geographic = false,
    tileWidthPx = 256,
    minimumLevel = 0,
    maximumLevel = 30,
    maximumScreenSpaceError = 2,
    terrainLevelErrorM = ellipsoidTerrainLevelErrorM,
  },
) {
  if (!(metresPerPixel > 0) || !Number.isFinite(latitudeDeg)) return null;
  const sse = maximumScreenSpaceError > 0 ? maximumScreenSpaceError : 2;
  let terrainLevel = 0;
  while (
    terrainLevel < MAX_TERRAIN_LEVEL &&
    !(terrainLevelErrorM(terrainLevel) / metresPerPixel <= sse)
  )
    terrainLevel += 1;
  const errorM = terrainLevelErrorM(terrainLevel);
  if (!(errorM > 0)) return null;
  const rootTiles = tilingScheme?.getNumberOfXTilesAtLevel?.(0) || 1;
  const widthRad = tilingScheme?.rectangle?.width || 2 * Math.PI;
  const latitudeFactor = geographic
    ? 1
    : Math.cos(toRadians(Math.min(89, Math.abs(latitudeDeg))));
  const levelZeroTexelM =
    (WGS84_MAXIMUM_RADIUS_M * widthRad * latitudeFactor) /
    ((tileWidthPx || 256) * rootTiles);
  const level = Math.max(0, Math.round(Math.log2(levelZeroTexelM / errorM)));
  if (!Number.isFinite(level)) return null;
  const top = Number.isFinite(maximumLevel) ? maximumLevel : 30;
  const bottom = Number.isFinite(minimumLevel) ? minimumLevel : 0;
  return Math.min(top, Math.max(bottom, level));
}

/**
 * The tiles at `level` holding `points`, in order, without repeats or tiles
 * `skip` reports as already asked for, at most `maxTiles`.
 * @param {{positionToTileXY: Function}} tilingScheme Cesium tiling scheme.
 * @param {Array<{lat: number, lon: number}>} points Degrees.
 * @param {number} level
 * @param {{maxTiles?: number, skip?: (key: string) => boolean}} [options]
 * @returns {Array<{x: number, y: number, level: number, key: string}>}
 */
export function tilesForPoints(
  tilingScheme,
  points,
  level,
  { maxTiles = ORBITAL_PREFETCH_MAX_TILES, skip = () => false } = {},
) {
  const tiles = [];
  if (typeof tilingScheme?.positionToTileXY !== 'function') return tiles;
  if (!Number.isInteger(level) || level < 0) return tiles;
  const seen = new Set();
  for (const point of points) {
    if (tiles.length >= maxTiles) break;
    const xy = tilingScheme.positionToTileXY(
      { longitude: toRadians(point.lon), latitude: toRadians(point.lat) },
      level,
    );
    if (!xy) continue;
    const key = `${level}/${xy.x}/${xy.y}`;
    if (seen.has(key) || skip(key)) continue;
    seen.add(key);
    tiles.push({ x: xy.x, y: xy.y, level, key });
  }
  return tiles;
}
