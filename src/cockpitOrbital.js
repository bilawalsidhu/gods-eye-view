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

/** The optical zoom steps. */
export const ORBITAL_ZOOM_LADDER = Object.freeze([1, 2, 4, 8]);

/** The tightest step. */
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
 * A zoom between steps moves to the step above it.
 * @param {number} zoom Current zoom.
 * @param {number} [maxZoom] The tightest step.
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
