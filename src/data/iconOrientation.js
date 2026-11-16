/**
 * Shared icon-orientation + horizon helpers. Orientation and culling serve the
 * moving-entity layers (commercial flights, military flights, AIS vessels);
 * `skyBackdropFactor` serves the detection overlay, which needs the same
 * silhouette geometry to know what a label is being read against. The helpers
 * that read the default renderer's scene or camera (`screenProjectedRotation`,
 * `perspectiveProjectedRotation`, `horizonOccluder`, `cameraPoseSignature`)
 * live in `src/render/cesium/iconOrientation.js`; the camera-basis rotation
 * itself is `courseScreenRotation` in `screenRotation.js`.
 *
 * THE ORIENTATION PROBLEM (2026-06-10 playtest): billboards are camera-facing
 * quads, so "point along the real-world course" must be computed in SCREEN
 * space. The previous approach mixed two regimes (surface-normal alignedAxis
 * at oblique pitch, camera-heading compensation at nadir) and broke in
 * tracked-entity orbit mode, where camera.heading is expressed in the
 * entity's reference frame — the tracked icon stayed glued to the viewport.
 *
 * THE FIX: transform the local course vector into world space, then project it
 * directly onto the camera's right/up basis. This stays valid when a forward
 * probe point would be off-screen or behind the camera during a >180° tracked
 * orbit. The camera-basis projection is exact at the viewport center and an
 * intentional orthographic approximation elsewhere: an off-center contact at
 * oblique pitch can diverge from a pinhole/window-space projection because the
 * latter also includes the course vector's depth component. The approximation
 * keeps rotation continuous through tracked orbits; field evidence, not an
 * unverified math swap, decides whether exact projection becomes preferred.
 */
import { WGS84 } from '../geo/ellipsoid.js';
import { stabilizeScreenRotation } from './screenRotation.js';

export { stabilizeScreenRotation };

/**
 * Half-width of the crossfade band centred on the ellipsoid silhouette, in
 * radians. ~1.1° per side: at the product's default 60° frustum on a 1280×800
 * viewport that is roughly 30 px of screen crossfade — wide enough that a
 * contact drifting across the horizon never pops, narrow enough that a label
 * plainly over ground still gets its full treatment.
 */
export const HORIZON_FEATHER_RAD = 0.019;

const _wgs84OneOverRadii = WGS84.oneOverRadii;

/**
 * How much SKY sits behind a world point from this camera: 0 (planet behind)
 * … 1 (sky behind), smoothly blended across a band centred on the horizon.
 *
 * THERE ARE TWO REGIMES AND THEY ANSWER DIFFERENT QUESTIONS. Read this before
 * trusting the number for anything other than a plate alpha.
 *
 * ABOVE the ellipsoid the horizon is the tangent silhouette and the test is a
 * genuine ray/ellipsoid hit test: 1 means the view ray through the point misses
 * the planet entirely. Here the function is the exact complement of
 * `horizonOccluder` (`src/render/cesium/iconOrientation.js`) — the occluder asks whether the planet is in FRONT of
 * a point (cull it), this asks whether it is BEHIND (what a screen-space label
 * anchored there is read against). For any point the occluder keeps, a ray that
 * hits the ellipsoid must hit it beyond the point, so the hit/miss test alone
 * settles the backdrop.
 *
 * AT OR BELOW the ellipsoid there is no tangent cone, and the test is NOT a ray
 * hit test. It is an EYE-PLANE convention: 1 means the point sits above the
 * camera's local geodetic horizontal. The two genuinely differ — from a camera
 * 18 m under the surface, the ray to a contact 900 m up and a few km out
 * CROSSES the ellipsoid on the way there, and the answer is still sky. That is
 * deliberate. A sub-ellipsoid camera is an artifact of the geoid/ellipsoid
 * split, not of being underground: the geoid runs ~34 m below the ellipsoid at
 * JFK, so a cockpit parked on the ramp there sits at −18 m of ellipsoid height
 * with the whole rendered world still above it. The ellipsoid that ray crosses
 * is not a surface anyone can see, so intersecting it would answer a question
 * nobody asked; what a label is read against is decided instead by whether it
 * sits above or below the viewer's eye level. Cesium's `EllipsoidalOccluder`
 * takes the same convention below the surface, so the two stay sign-consistent
 * — the complementarity above survives as agreement here.
 *
 * The regimes MEET rather than being switched between: the horizon dip
 * acos(R/(R+h)) falls to zero as the camera settles onto the surface, so the
 * tangent cone opens continuously to the horizontal plane, and clamping the
 * cone's sine at 1 (half-angle 90°) IS that limit — not a special case.
 *
 * Computed in scaled space, where WGS84 becomes a unit sphere. That map is
 * affine, so both regimes stay exact: above the surface ray-surface
 * intersection is preserved and the zero crossing is the true silhouette rather
 * than a spherical stand-in; below it the eye plane is the true GEODETIC
 * tangent plane, because the scaled radial maps back to (x/a², y/a², z/b²), the
 * real surface normal, which at 40°N sits 0.19° off the geocentric radial. Only
 * the magnitude of the margin picks up the flattening, and a feather band does
 * not care about a third of a percent.
 *
 * Deliberately geometric, not photometric, in BOTH regimes: sampling rendered
 * pixels behind every label would be correct about mountains and towers that
 * rise above the horizon, and would also cost a readback per label per frame.
 * The band absorbs that approximation — a contact just above the horizon lands
 * mid-blend, which is the honest answer when the backdrop is part sky.
 *
 * @param {Cesium.Cartesian3} cameraPosition World camera position.
 * @param {Cesium.Cartesian3} position World position of the labelled point.
 * @param {number} [featherRad=HORIZON_FEATHER_RAD] Half-width of the blend band.
 * @returns {number} 0 (ground behind) … 1 (sky behind).
 */
export function skyBackdropFactor(
  cameraPosition,
  position,
  featherRad = HORIZON_FEATHER_RAD,
) {
  if (!cameraPosition || !position) return 0;

  const s = _wgs84OneOverRadii;
  const cx = cameraPosition.x * s.x;
  const cy = cameraPosition.y * s.y;
  const cz = cameraPosition.z * s.z;
  const cameraMag = Math.sqrt(cx * cx + cy * cy + cz * cz);
  // Only the planet's exact centre (or a non-finite camera) has no local
  // vertical to measure against. Everything else — including the sub-ellipsoid
  // cameras that coastal ground level actually produces — gets a real answer.
  // `> 0` already rejects NaN and negatives; the finite check also rejects an
  // infinite coordinate, which would otherwise normalize to NaN below and slip
  // a NaN plate alpha into the paint.
  if (!(cameraMag > 0) || !Number.isFinite(cameraMag)) return 0;

  let dx = position.x * s.x - cx;
  let dy = position.y * s.y - cy;
  let dz = position.z * s.z - cz;
  const rayMag = Math.sqrt(dx * dx + dy * dy + dz * dz);
  // Same two rejections on the ray: a zero-length one has no direction, and an
  // infinite one normalizes to NaN.
  if (!(rayMag > 0) || !Number.isFinite(rayMag)) return 0;
  dx /= rayMag;
  dy /= rayMag;
  dz /= rayMag;

  // Angle between the view ray and the direction to the planet's centre,
  // against the half-angle of the tangent cone. Inside the cone the ray strikes
  // the planet; outside it, the ray escapes to sky.
  const cosToCentre = -(cx * dx + cy * dy + cz * dz) / cameraMag;
  const rayAngle = Math.acos(Math.min(1, Math.max(-1, cosToCentre)));
  // The clamp is the eye-level case described above, reached as a limit rather
  // than as a special case: at and under the surface the cone has opened to the
  // full 90° half-angle and the test reads "above or below local horizontal".
  const horizonHalfAngle = Math.asin(Math.min(1, 1 / cameraMag));
  const margin = rayAngle - horizonHalfAngle;

  if (!(featherRad > 0)) return margin > 0 ? 1 : 0;
  const t = Math.min(1, Math.max(0, margin / (2 * featherRad) + 0.5));
  // Smoothstep: C1-continuous, so a contact crossing the horizon fades rather
  // than steps, and the fade has no visible corner at either edge of the band.
  return t * t * (3 - 2 * t);
}
