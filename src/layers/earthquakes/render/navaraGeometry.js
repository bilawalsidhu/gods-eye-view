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

export {
  viewFrame,
  groundClipBounds as discClipBounds,
} from '../../shared/render/navaraGroundGeometry.js';
