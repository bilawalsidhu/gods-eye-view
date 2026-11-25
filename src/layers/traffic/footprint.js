import { toCartographicRadians } from '../../geo/ellipsoid.js';
import { toDegrees } from '../../geo/vector.js';
import { tilesForBounds, tileToBBox } from '../../data/tomtomTiles.js';

const RETICLE_RANGE_KM = 10;
const RETICLE_TILE_CAP = 16;
const tileKey = (tile) => `${tile.z}/${tile.x}/${tile.y}`;
const cross = (a, b, c) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Convex ground envelope of the sampled screen square. */
export function convexFootprint(points) {
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length > 1 && cross(out.at(-2), out.at(-1), p) <= 0) out.pop();
      out.push(p);
    }
    return out;
  };
  return [...half(sorted).slice(0, -1), ...half(sorted.reverse()).slice(0, -1)];
}

/** Select only tiles intersecting the convex footprint, ordered from the camera nadir. */
export function footprintTiles(polygon, zoom, near) {
  if (polygon.length < 3) return [];
  const bounds = {
    west: Math.min(...polygon.map((p) => p[0])),
    east: Math.max(...polygon.map((p) => p[0])),
    south: Math.min(...polygon.map((p) => p[1])),
    north: Math.max(...polygon.map((p) => p[1])),
  };
  const cos = Math.cos((near.lat * Math.PI) / 180);
  return tilesForBounds(bounds, zoom, { maxTiles: 4096 })
    .filter((t) => {
      const b = tileToBBox(t.z, t.x, t.y);
      const corners = [
        [b.west, b.south],
        [b.east, b.south],
        [b.east, b.north],
        [b.west, b.north],
      ];
      for (let i = 0; i < polygon.length; i++)
        if (
          corners.every(
            (p) =>
              cross(polygon[i], polygon[(i + 1) % polygon.length], p) < -1e-12,
          )
        )
          return false;
      return true;
    })
    .sort((a, b) => {
      const distance = (t) => {
        const box = tileToBBox(t.z, t.x, t.y);
        return (
          ((box.west + box.east) / 2 - near.lon) ** 2 * cos * cos +
          ((box.south + box.north) / 2 - near.lat) ** 2
        );
      };
      return distance(a) - distance(b) || a.y - b.y || a.x - b.x;
    });
}

const NO_DIRECTION = Object.freeze({ x: 0, y: 0, z: 0 });

/**
 * The pick ray's direction at a pixel; none (a zero vector, as an unset ray
 * had) where the renderer has no ray there, such as on a canvas of no size.
 */
function rayDirection(query, x, y) {
  try {
    return query.pickRay(x, y)?.direction ?? NO_DIRECTION;
  } catch {
    return NO_DIRECTION;
  }
}

/**
 * The ground footprint of the reticle square, sampled through the camera and
 * query ports on camera events only, never in the animation loop. Null
 * without both ports.
 * @returns {(view: {camera: object|null, query: object|null, width: number,
 *   height: number}, altitude: number) => object|null}
 */
export function createReticleFootprint() {
  return ({ camera, query, width, height }, altitude) => {
    if (!camera || !query) return null;
    const pose = camera.pose();
    const nadir = toCartographicRadians(pose.position);
    if (!nadir) return null;
    const near = {
      lat: toDegrees(nadir.lat),
      lon: toDegrees(nadir.lon),
    };
    const side = Math.min(width, height),
      left = (width - side) / 2,
      top = (height - side) / 2;
    const points = [];
    for (let row = 0; row < 5; row++)
      for (let col = 0; col < 5; col++) {
        const x = left + (side * col) / 4,
          y = top + (side * row) / 4;
        const hit = query.pickEllipsoid(x, y);
        const carto = hit && toCartographicRadians(hit);
        let dx, dy;
        if (carto) {
          dy = (toDegrees(carto.lat) - near.lat) * 111.195;
          let dlon = toDegrees(carto.lon) - near.lon;
          dlon -= 360 * Math.round(dlon / 360);
          dx = dlon * 111.195 * Math.cos(nadir.lat);
        } else {
          const d = rayDirection(query, x, y);
          dx = -Math.sin(nadir.lon) * d.x + Math.cos(nadir.lon) * d.y;
          dy =
            -Math.sin(nadir.lat) * Math.cos(nadir.lon) * d.x -
            Math.sin(nadir.lat) * Math.sin(nadir.lon) * d.y +
            Math.cos(nadir.lat) * d.z;
          const length = Math.hypot(dx, dy) || 1;
          dx = (dx / length) * RETICLE_RANGE_KM;
          dy = (dy / length) * RETICLE_RANGE_KM;
        }
        points.push([dx, dy]);
      }
    let range = RETICLE_RANGE_KM,
      polygon,
      coarse;
    do {
      polygon = convexFootprint(
        points.map(([dx, dy]) => {
          const scale = Math.min(1, range / Math.max(1e-9, Math.hypot(dx, dy)));
          return [
            near.lon +
              (dx * scale) / (111.195 * Math.max(0.05, Math.cos(nadir.lat))),
            near.lat + (dy * scale) / 111.195,
          ];
        }),
      );
      if (polygon.some((p) => Math.abs(p[0]) > 180 || Math.abs(p[1]) > 85))
        return null;
      coarse = footprintTiles(polygon, 12, near);
      if (coarse.length <= RETICLE_TILE_CAP) break;
      range *= 0.8;
    } while (range > 0.5);
    const detail =
      altitude <= 4500
        ? footprintTiles(polygon, 14, near).slice(0, RETICLE_TILE_CAP)
        : [];
    const bounds = {
      west: Math.min(...polygon.map((p) => p[0])),
      east: Math.max(...polygon.map((p) => p[0])),
      south: Math.min(...polygon.map((p) => p[1])),
      north: Math.max(...polygon.map((p) => p[1])),
    };
    return {
      ...bounds,
      coverage: {
        polygon,
        near,
        rangeKm: range,
        coarse,
        detail,
        viewKey: [
          nadir.lat,
          nadir.lon,
          nadir.height / 10000,
          pose.heading,
          pose.pitch,
        ]
          .map((v) => Number(v || 0).toFixed(7))
          .join(','),
        key: [...coarse, ...detail].map(tileKey).sort().join('|'),
      },
    };
  };
}
