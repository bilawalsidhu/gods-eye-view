import * as geo from '../../geo/index.js';
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

/** Reusable camera scratch; sampled only on camera events, never in the animation loop. */
export function createReticleFootprint() {
  const pixels = Array.from({ length: 25 }, () => geo.cartesian2.create());
  const carto = geo.cartographic.create();
  return (engine, altitude) => {
    const camera = engine?.camera;
    if (!camera?.pickRay) return null;
    const pose = camera.pose();
    const nadir = pose.cartographic;
    const canvas = engine.host.canvas;
    const near = {
      lat: geo.math.toDegrees(nadir.latitude),
      lon: geo.math.toDegrees(nadir.longitude),
    };
    const width = canvas.clientWidth || canvas.width,
      height = canvas.clientHeight || canvas.height;
    const side = Math.min(width, height),
      left = (width - side) / 2,
      top = (height - side) / 2;
    const points = [];
    for (let row = 0; row < 5; row++)
      for (let col = 0; col < 5; col++) {
        const i = row * 5 + col,
          p = pixels[i];
        p.x = left + (side * col) / 4;
        p.y = top + (side * row) / 4;
        const hit = camera.pickEllipsoid(p);
        let dx, dy;
        if (hit) {
          geo.cartographic.fromCartesian(hit, geo.ellipsoid.WGS84, carto);
          dy = (geo.math.toDegrees(carto.latitude) - near.lat) * 111.195;
          let dlon = geo.math.toDegrees(carto.longitude) - near.lon;
          dlon -= 360 * Math.round(dlon / 360);
          dx = dlon * 111.195 * Math.cos(nadir.latitude);
        } else {
          const picked = camera.pickRay(p);
          if (!picked) continue;
          const d = picked.direction;
          dx =
            -Math.sin(nadir.longitude) * d.x + Math.cos(nadir.longitude) * d.y;
          dy =
            -Math.sin(nadir.latitude) * Math.cos(nadir.longitude) * d.x -
            Math.sin(nadir.latitude) * Math.sin(nadir.longitude) * d.y +
            Math.cos(nadir.latitude) * d.z;
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
              (dx * scale) /
                (111.195 * Math.max(0.05, Math.cos(nadir.latitude))),
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
          nadir.latitude,
          nadir.longitude,
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
