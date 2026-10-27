// Native default circles have 48 boundary samples (1-degree granularity,
// multiplied by eight by EllipseGeometryLibrary). Reproduce the boundary
// mathematically, then classify the visible surface inside its convex sides.
import * as geo from '../../../geo/index.js';

export const DISC_EDGES = 48;
const ellipsoid = geo.ellipsoid.WGS84;
export function discFrame(disc) {
  const center = { ...disc.position };
  const magnitude = Math.hypot(center.x, center.y, center.z);
  const unit = geo.cartesian3.normalize(center, geo.cartesian3.create());
  const east = geo.cartesian3.create(-center.y, center.x, 0);
  if (geo.cartesian3.magnitude(east) === 0) east.x = 1;
  geo.cartesian3.normalize(east, east);
  const sphericalNorth = geo.cartesian3.cross(
    unit,
    east,
    geo.cartesian3.create(),
  );
  const up = ellipsoid.geodeticSurfaceNormal(center, geo.cartesian3.create());
  const north = geo.cartesian3.cross(up, east, geo.cartesian3.create());
  const angle = disc.baseRadius / magnitude;
  const cosine = Math.cos(angle),
    sine = Math.sin(angle);
  const boundary = [];
  for (let i = 0; i < DISC_EDGES; i++) {
    const theta = (i * 2 * Math.PI) / DISC_EDGES;
    const a = Math.sin(theta) * sine * magnitude;
    const b = -Math.cos(theta) * sine * magnitude;
    const p = geo.cartesian3.create(
      center.x * cosine + east.x * a + sphericalNorth.x * b,
      center.y * cosine + east.y * a + sphericalNorth.y * b,
      center.z * cosine + east.z * a + sphericalNorth.z * b,
    );
    ellipsoid.scaleToGeodeticSurface(p, p);
    const dx = p.x - center.x,
      dy = p.y - center.y,
      dz = p.z - center.z;
    boundary.push({
      x: dx * east.x + dy * east.y + dz * east.z,
      y: dx * north.x + dy * north.y + dz * north.z,
      world: p,
    });
  }
  const phase = Math.atan2(boundary[0].x, -boundary[0].y);
  const edges = new Float32Array(DISC_EDGES * 4);
  for (let i = 0; i < DISC_EDGES; i++) {
    const a = boundary[i],
      b = boundary[(i + 1) % DISC_EDGES];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    let nx = (b.y - a.y) / length,
      ny = -(b.x - a.x) / length;
    let offset = nx * a.x + ny * a.y;
    if (offset < 0) {
      nx = -nx;
      ny = -ny;
      offset = -offset;
    }
    let angle = i === 0 ? 0 : Math.atan2(a.x, -a.y) - phase;
    if (angle < 0) angle += 2 * Math.PI;
    edges.set([nx, ny, offset, angle], i * 4);
  }
  const r = disc.baseRadius;
  return {
    center,
    phase,
    east,
    north,
    up,
    edges,
    boundary,
    radius: r,
    // At orbital LOD the rendered globe mesh can lie well below the
    // ellipsoid (measured -26km over Alaska). Native GroundPrimitive uses
    // -100km as its conservative default floor; do not clip that surface.
    floor: -100000 - ((r * r) / (2 * ellipsoid.minimumRadius)) * 1.1,
    ceiling: 12000,
  };
}

/** Camera-relative transforms in JS float64; only nearby metres enter GLSL. */
export function viewFrame(frame, matrix, out) {
  const m = matrix.elements;
  const transform = (p, offset, translate) => {
    out[offset] =
      m[0] * p.x + m[4] * p.y + m[8] * p.z + (translate ? m[12] : 0);
    out[offset + 1] =
      m[1] * p.x + m[5] * p.y + m[9] * p.z + (translate ? m[13] : 0);
    out[offset + 2] =
      m[2] * p.x + m[6] * p.y + m[10] * p.z + (translate ? m[14] : 0);
  };
  transform(frame.center, 0, true);
  transform(frame.east, 3, false);
  transform(frame.north, 6, false);
  transform(frame.up, 9, false);
  return out;
}

/** Conservative clip bounds, including a camera inside/crossing the volume. */
export function discClipBounds(frame, view, projection, out) {
  const p = projection.elements;
  let x0 = 1,
    y0 = 1,
    x1 = -1,
    y1 = -1,
    front = 0,
    behind = 0;
  for (let i = 0; i < 8; i++) {
    const x = (i & 1 ? 1 : -1) * frame.radius;
    const y = (i & 2 ? 1 : -1) * frame.radius;
    const z = i & 4 ? frame.ceiling : frame.floor;
    const vx = view[0] + view[3] * x + view[6] * y + view[9] * z;
    const vy = view[1] + view[4] * x + view[7] * y + view[10] * z;
    const vz = view[2] + view[5] * x + view[8] * y + view[11] * z;
    const w = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
    if (w <= 0) {
      behind++;
      continue;
    }
    front++;
    const cx = (p[0] * vx + p[4] * vy + p[8] * vz + p[12]) / w;
    const cy = (p[1] * vx + p[5] * vy + p[9] * vz + p[13]) / w;
    x0 = Math.min(x0, cx);
    y0 = Math.min(y0, cy);
    x1 = Math.max(x1, cx);
    y1 = Math.max(y1, cy);
  }
  if (front && behind) {
    x0 = -1;
    y0 = -1;
    x1 = 1;
    y1 = 1;
  }
  if (!front || x1 < -1 || y1 < -1 || x0 > 1 || y0 > 1) out.fill(2);
  else {
    out[0] = Math.max(-1, x0);
    out[1] = Math.max(-1, y0);
    out[2] = Math.min(1, x1);
    out[3] = Math.min(1, y1);
  }
  return out;
}
