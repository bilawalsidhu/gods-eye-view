/**
 * Sky view brightness ESTIMATE. Pure: no DOM, no Cesium,
 * no satellite.js, so it runs in the worker and in node tests alike.
 *
 * Diffuse-sphere model from the radar cross-section (RCS) CelesTrak's SATCAT
 * publishes per object:
 *   R2   = RCS / pi                         (sphere of the same cross-section)
 *   F(p) = (sin p + (pi - p) cos p) / pi     (Lambert sphere phase function)
 *   m    = -26.74 - 2.5 log10((2/3) * rho * R2 * F(p) / r^2) + offset
 * with rho = 0.2 (assumed albedo), p the Sun-satellite-observer phase angle
 * and r the observer range in metres. RCS is a radar size, not an optical
 * one, so this is good to about +/- 2 magnitudes and the UI always says
 * "est.". A missing RCS gives no estimate (null), never a guess.
 *
 * Stations are several magnitudes brighter than the plain model (large, highly
 * reflective solar arrays), so they carry a fixed offset from
 * STATION_OFFSETS, calibrated against three recorded Heavens-Above ISS passes
 * (values and sources in brightness.test.mjs).
 */

const D2R = Math.PI / 180;
export const SUN_MAG = -26.74;
export const ALBEDO = 0.2;

/**
 * Per-object offsets (magnitudes, added to the model) keyed by NORAD id.
 * 25544 ISS (SATCAT RCS 399.05 m2): the mid-range of (Heavens-Above - model)
 * over the eight sunlit points of three Houston passes on 2026-10-14/15/18,
 * so no point is off by more than 1.0 mag. The plain model is 2.7..4.6 mag
 * too faint there (more at large phase angles). brightness.test.mjs pins the
 * data and re-derives this number.
 */
export const STATION_OFFSETS = Object.freeze({ 25544: -3.6 });

/** Naked-eye limit slider (est. mag), */
export const MAG_LIMIT_MIN = 3;
export const MAG_LIMIT_MAX = 7;
export const MAG_LIMIT_DEFAULT = 5.5;
/** Classes that are naked-eye candidates whatever their estimate. */
export const ALWAYS_ELIGIBLE_CLASSES = Object.freeze(['station', 'visual']);

/** Lambert-sphere phase function, F(0) = 1, F(180 deg) = 0. */
export function phaseFunction(phaseRad) {
  const p = Math.min(Math.PI, Math.max(0, Number(phaseRad)));
  if (!Number.isFinite(p)) return NaN;
  return (Math.sin(p) + (Math.PI - p) * Math.cos(p)) / Math.PI;
}

/**
 * Sun-satellite-observer angle in degrees from three position vectors in one
 * frame (km): the angle at the satellite between the Sun and the observer.
 */
export function phaseAngleDeg(sat, observer, sun) {
  const ax = sun.x - sat.x;
  const ay = sun.y - sat.y;
  const az = sun.z - sat.z;
  const bx = observer.x - sat.x;
  const by = observer.y - sat.y;
  const bz = observer.z - sat.z;
  const la = Math.hypot(ax, ay, az);
  const lb = Math.hypot(bx, by, bz);
  if (!(la > 0) || !(lb > 0)) return NaN;
  const cos = (ax * bx + ay * by + az * bz) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, cos))) / D2R;
}

/** Usable RCS (m2) or null: SATCAT leaves it empty for most new objects. */
export function rcsValue(rcs) {
  if (rcs === null || rcs === undefined || rcs === '') return null;
  const v = Number(rcs);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * The plain diffuse-sphere magnitude (no offsets), or null when an input is
 * missing or the satellite shows no lit face (phase 180 deg).
 */
export function diffuseSphereMagnitude({
  rcsM2,
  rangeKm,
  phaseDeg,
  albedo = ALBEDO,
}) {
  const rcs = rcsValue(rcsM2);
  const r = Number(rangeKm) * 1000;
  const f = phaseFunction(Number(phaseDeg) * D2R);
  if (rcs == null || !(r > 0) || !(f > 1e-12)) return null;
  const R2 = rcs / Math.PI;
  return SUN_MAG - 2.5 * Math.log10(((2 / 3) * albedo * R2 * f) / (r * r));
}

/**
 * Estimated visual magnitude (smaller = brighter), or null without an RCS.
 * Shadowed objects are not visible at all: callers pass sunlit=false to get
 * null.
 */
export function estimateMagnitude({
  noradId,
  rcsM2,
  rangeKm,
  phaseDeg,
  sunlit = true,
}) {
  if (!sunlit) return null;
  const base = diffuseSphereMagnitude({ rcsM2, rangeKm, phaseDeg });
  if (base == null) return null;
  return base + (STATION_OFFSETS[Number(noradId)] ?? 0);
}

/** Clamp a limit from the slider to 3..7 (default on junk). */
export function clampMagLimit(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return MAG_LIMIT_DEFAULT;
  return Math.min(MAG_LIMIT_MAX, Math.max(MAG_LIMIT_MIN, v));
}

/**
 * Naked-eye candidate: VISIBLE (sunlit under a dark sky)
 * and either est. mag <= limit or class station/visual. An object without an
 * estimate is only a candidate through its class.
 */
export function isNakedEyeCandidate({
  visible,
  klass,
  estMag,
  limit = MAG_LIMIT_DEFAULT,
}) {
  if (!visible) return false;
  if (ALWAYS_ELIGIBLE_CLASSES.includes(klass)) return true;
  return Number.isFinite(estMag) && estMag <= clampMagLimit(limit);
}

/** "est. mag 3.2" (or null without an estimate). Never more than 1 decimal. */
export function formatEstMag(estMag) {
  if (!Number.isFinite(estMag)) return null;
  const v = Math.round(estMag * 10) / 10;
  return `est. mag ${v === 0 ? '0.0' : v.toFixed(1)}`;
}
