import {
  DoubleSide,
  ExtrudeGeometry,
  MeshLambertMaterial,
  Path,
  Shape,
} from 'three';
import * as geo from '../../../geo/index.js';

export const INSTALLATION_DRAPE_DEPTH_M = 40000;

function localPoint([longitude, latitude], origin, axes) {
  const point = geo.cartesian3.fromDegrees(longitude, latitude);
  const delta = geo.cartesian3.subtract(point, origin, geo.cartesian3.create());
  return {
    x: geo.cartesian3.dot(delta, axes.east),
    y: geo.cartesian3.dot(delta, axes.north),
  };
}

function addRing(path, ring, origin, axes) {
  const points = ring.map((point) => localPoint(point, origin, axes));
  if (points.length < 3) return false;
  path.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) path.lineTo(point.x, point.y);
  path.closePath();
  return true;
}

function offsetLine(line, halfWidth, origin, axes) {
  const points = [];
  for (const point of line) {
    const local = localPoint(point, origin, axes);
    const previous = points.at(-1);
    if (
      !previous ||
      Math.hypot(local.x - previous.x, local.y - previous.y) >= 0.01
    )
      points.push(local);
  }
  const closed =
    points.length > 2 &&
    Math.hypot(points[0].x - points.at(-1).x, points[0].y - points.at(-1).y) <
      1;
  if (closed) points.pop();
  if (points.length < 2) return null;

  const side = (index, direction) => {
    const previous = points[index === 0 ? points.length - 1 : index - 1];
    const current = points[index];
    const next = points[index === points.length - 1 ? 0 : index + 1];
    const before = { x: current.x - previous.x, y: current.y - previous.y };
    const after = { x: next.x - current.x, y: next.y - current.y };
    const beforeLength = Math.hypot(before.x, before.y);
    const afterLength = Math.hypot(after.x, after.y);
    const beforeNormal = {
      x: -before.y / beforeLength,
      y: before.x / beforeLength,
    };
    const afterNormal = { x: -after.y / afterLength, y: after.x / afterLength };
    if (!closed && (index === 0 || index === points.length - 1)) {
      const normal = index === 0 ? afterNormal : beforeNormal;
      return {
        x: current.x + normal.x * halfWidth * direction,
        y: current.y + normal.y * halfWidth * direction,
      };
    }
    const miter = {
      x: beforeNormal.x + afterNormal.x,
      y: beforeNormal.y + afterNormal.y,
    };
    const length = Math.hypot(miter.x, miter.y);
    if (length < 1e-6)
      return {
        x: current.x + afterNormal.x * halfWidth * direction,
        y: current.y + afterNormal.y * halfWidth * direction,
      };
    miter.x /= length;
    miter.y /= length;
    const denominator = miter.x * afterNormal.x + miter.y * afterNormal.y;
    const distance =
      halfWidth * Math.min(4, 1 / Math.max(0.25, Math.abs(denominator)));
    return {
      x: current.x + miter.x * distance * direction,
      y: current.y + miter.y * distance * direction,
    };
  };

  const outer = points.map((_, index) => side(index, 1));
  if (!closed) {
    const inner = points.map((_, index) => side(index, -1)).reverse();
    return [...outer, ...inner];
  }
  return { outer, inner: points.map((_, index) => side(index, -1)) };
}

/** Build a real DrapedMesh volume for one footprint, including its holes. */
export function createInstallationDrapedMesh(
  record,
  rings,
  {
    color,
    opacity = 0.22,
    globeNormal,
    globeDepth,
    DrapedMesh,
    setupMaterialForDrape,
  },
) {
  const origin = geo.cartesian3.fromDegrees(record.longitude, record.latitude);
  const frame = geo.transforms.eastNorthUpToFixedFrame(origin);
  const axes = {
    east: geo.cartesian3.create(frame[0], frame[1], frame[2]),
    north: geo.cartesian3.create(frame[4], frame[5], frame[6]),
  };
  const shape = new Shape();
  if (!addRing(shape, rings[0] || [], origin, axes)) return null;
  for (const ring of rings.slice(1)) {
    const hole = new Path();
    if (addRing(hole, ring, origin, axes)) shape.holes.push(hole);
  }

  const geometry = new ExtrudeGeometry(shape, {
    depth: INSTALLATION_DRAPE_DEPTH_M,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -INSTALLATION_DRAPE_DEPTH_M / 2);
  const material = new MeshLambertMaterial({
    color,
    opacity,
    transparent: opacity < 1,
    depthWrite: false,
    side: DoubleSide,
  });
  setupMaterialForDrape?.(material, globeNormal, globeDepth);
  const mesh = new DrapedMesh(geometry, material);
  mesh.matrix.fromArray(frame);
  mesh.matrixAutoUpdate = false;
  mesh.matrixWorldNeedsUpdate = true;
  mesh.userData.installationId = record.id;
  return mesh;
}

/** Build a ground-classified, fixed-world-width ribbon around a native outline. */
export function createInstallationOutlineDrapedMesh(
  record,
  line,
  { color, widthM, globeNormal, globeDepth, DrapedMesh, setupMaterialForDrape },
) {
  const origin = geo.cartesian3.fromDegrees(record.longitude, record.latitude);
  const frame = geo.transforms.eastNorthUpToFixedFrame(origin);
  const axes = {
    east: geo.cartesian3.create(frame[0], frame[1], frame[2]),
    north: geo.cartesian3.create(frame[4], frame[5], frame[6]),
  };
  const outline = offsetLine(line, Math.max(1, widthM / 2), origin, axes);
  if (!outline) return null;

  const shape = new Shape();
  const addLocalRing = (path, points) => {
    if (points.length < 3) return false;
    path.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) path.lineTo(point.x, point.y);
    path.closePath();
    return true;
  };
  if (Array.isArray(outline)) {
    if (!addLocalRing(shape, outline)) return null;
  } else {
    if (!addLocalRing(shape, outline.outer)) return null;
    const hole = new Path();
    if (addLocalRing(hole, outline.inner.slice().reverse()))
      shape.holes.push(hole);
  }

  const geometry = new ExtrudeGeometry(shape, {
    depth: INSTALLATION_DRAPE_DEPTH_M,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -INSTALLATION_DRAPE_DEPTH_M / 2);
  const material = new MeshLambertMaterial({
    color,
    opacity: 0.85,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
  setupMaterialForDrape?.(material, globeNormal, globeDepth);
  const mesh = new DrapedMesh(geometry, material);
  mesh.matrix.fromArray(frame);
  mesh.matrixAutoUpdate = false;
  mesh.matrixWorldNeedsUpdate = true;
  mesh.userData.installationId = record.id;
  mesh.userData.installationOutline = true;
  return mesh;
}
