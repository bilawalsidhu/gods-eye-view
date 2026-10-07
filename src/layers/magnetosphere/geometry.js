/**
 * Geometry for the magnetosphere layer: where to seed field lines, and the
 * shape of the magnetopause.
 *
 * Pure maths over plain vectors, in kilometres, geocentric Earth-fixed. No
 * Cesium here — this is the part worth testing, and it tests far better
 * without a renderer attached.
 *
 * @module layers/magnetosphere/geometry
 */
import { boundaryRadius } from './magnetopause.js';
import { EARTH_RADIUS_KM, surfacePoint } from './trace.js';

/**
 * Seed latitudes for the filaments.
 *
 * Chosen for what they show rather than evenly: low latitudes produce stubby
 * lines that add clutter near the surface, and the interesting structure —
 * lines reaching several Earth radii, where the oval maps — is all above 50
 * degrees. Both hemispheres, because the southern one is real and usually
 * forgotten.
 */
export const SEED_LATITUDES = Object.freeze([
  55, 62, 68, 73, 78, -55, -62, -68, -73, -78,
]);

/**
 * Seed points on a ring of meridians.
 *
 * @param {number} meridians How many longitudes to seed on.
 * @param {number} [altitudeKm] Height above the surface to start from.
 */
export function fieldLineSeeds(meridians = 12, altitudeKm = 120) {
  const seeds = [];
  for (let i = 0; i < meridians; i++) {
    const longitude = -180 + (360 * i) / meridians;
    for (const latitude of SEED_LATITUDES) {
      seeds.push({
        latitude,
        longitude,
        position: surfacePoint(
          latitude,
          longitude,
          EARTH_RADIUS_KM + altitudeKm,
        ),
      });
    }
  }
  return seeds;
}

/** Unit vector, or null for a degenerate input. */
export function normalize(v) {
  const length = Math.hypot(v.x, v.y, v.z);
  if (!(length > 0)) return null;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/**
 * An orthonormal basis whose first axis points at the Sun.
 *
 * The Shue boundary is a surface of revolution about the Earth-Sun line, so
 * the other two axes are arbitrary as long as they are perpendicular — which
 * is why this layer needs the Sun direction but not full GSM. Picking the
 * seed axis by the smallest component avoids the degenerate cross product
 * when the Sun happens to lie near whichever axis we guessed.
 */
export function sunAlignedBasis(sunDirection) {
  const x = normalize(sunDirection);
  if (!x) return null;
  const abs = { x: Math.abs(x.x), y: Math.abs(x.y), z: Math.abs(x.z) };
  const seed =
    abs.x <= abs.y && abs.x <= abs.z
      ? { x: 1, y: 0, z: 0 }
      : abs.y <= abs.z
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 };
  const y = normalize({
    x: x.y * seed.z - x.z * seed.y,
    y: x.z * seed.x - x.x * seed.z,
    z: x.x * seed.y - x.y * seed.x,
  });
  if (!y) return null;
  const z = {
    x: x.y * y.z - x.z * y.y,
    y: x.z * y.x - x.x * y.z,
    z: x.x * y.y - x.y * y.x,
  };
  return { x, y, z };
}

/**
 * How far down the tail the boundary is still a surface worth drawing.
 *
 * The Shue form diverges as theta approaches pi: the magnetotail does not
 * close, which is physically true and visually useless. Stopping short of
 * that is a drawing decision, and the layer says so rather than implying the
 * tail ends where the polyline does.
 */
export const MAX_BOUNDARY_ANGLE_RAD = (150 * Math.PI) / 180;

/**
 * Magnetopause as a wireframe: meridian arcs plus rings of constant angle.
 *
 * A cage rather than a solid surface, deliberately. The boundary is a model
 * fit, not an object, and a translucent shell reads as something physical
 * sitting in space — while also fighting the depth buffer against everything
 * inside it.
 *
 * @returns {{meridians:Array<Array<object>>, rings:Array<Array<object>>}} km.
 */
export function magnetopauseWireframe(
  parameters,
  sunDirection,
  { meridians = 16, rings = 6, samplesPerMeridian = 40 } = {},
) {
  const basis = sunAlignedBasis(sunDirection);
  if (!basis || !parameters) return null;
  const toWorld = (alongSun, acrossA, acrossB) => ({
    x: basis.x.x * alongSun + basis.y.x * acrossA + basis.z.x * acrossB,
    y: basis.x.y * alongSun + basis.y.y * acrossA + basis.z.y * acrossB,
    z: basis.x.z * alongSun + basis.y.z * acrossA + basis.z.z * acrossB,
  });
  const point = (theta, phi) => {
    const r = boundaryRadius(parameters, theta) * EARTH_RADIUS_KM;
    const along = r * Math.cos(theta);
    const across = r * Math.sin(theta);
    return toWorld(along, across * Math.cos(phi), across * Math.sin(phi));
  };

  const meridianLines = [];
  for (let m = 0; m < meridians; m++) {
    const phi = (2 * Math.PI * m) / meridians;
    const line = [];
    for (let s = 0; s <= samplesPerMeridian; s++) {
      line.push(point((MAX_BOUNDARY_ANGLE_RAD * s) / samplesPerMeridian, phi));
    }
    meridianLines.push(line);
  }

  const ringLines = [];
  for (let r = 1; r <= rings; r++) {
    const theta = (MAX_BOUNDARY_ANGLE_RAD * r) / (rings + 1);
    const line = [];
    const steps = 64;
    for (let s = 0; s <= steps; s++) {
      line.push(point(theta, (2 * Math.PI * s) / steps));
    }
    ringLines.push(line);
  }
  return { meridians: meridianLines, rings: ringLines };
}

/**
 * Where a traced line crosses the boundary, if it does.
 *
 * A line whose apex lies outside the magnetopause is not a closed loop out
 * there — it has been opened by the solar wind. Clipping at the crossing is
 * more honest than drawing a tidy closed arc through a boundary the same
 * frame says it cannot cross.
 */
export function clipToBoundary(points, parameters, sunDirection) {
  const basis = sunAlignedBasis(sunDirection);
  if (!basis || !parameters) return { points, clipped: false };
  const outside = (p) => {
    const r = Math.hypot(p.x, p.y, p.z);
    if (!(r > 0)) return false;
    const cosTheta = (p.x * basis.x.x + p.y * basis.x.y + p.z * basis.x.z) / r;
    const theta = Math.acos(Math.min(1, Math.max(-1, cosTheta)));
    if (theta >= MAX_BOUNDARY_ANGLE_RAD) return false;
    return r > boundaryRadius(parameters, theta) * EARTH_RADIUS_KM;
  };
  const index = points.findIndex(outside);
  if (index < 0) return { points, clipped: false };
  return { points: points.slice(0, Math.max(index, 2)), clipped: true };
}
