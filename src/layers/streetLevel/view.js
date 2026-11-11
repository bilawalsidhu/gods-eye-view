import { readSurface } from '../../globe/surfacePlacement.js';
// What Street Level reads of the camera and the ground, on the globe
// contract: `view` is the layer's display (render/display.js), whose
// `engine` it asks. Screen rays meet an ellipsoid raised to the ground
// under the camera, as Cesium's camera.pickEllipsoid does with that
// ellipsoid, so a hidden globe (Google 3D) still has a ground to aim at.

import * as geo from '../../geo/index.js';
import { intersectEllipsoid } from '../../globe/cameraMath.js';
import { wrapLon } from './tileMath.js';

const engineOf = (view) => view?.engine ?? null;

/** The camera's Cartographic (radians, metres), or null without an engine. */
export const cameraLocation = (view) =>
  engineOf(view)?.camera.pose().cartographic ?? null;

/** The canvas size in CSS px ({0, 0} without an engine). */
function canvasSize(view) {
  const size = engineOf(view)?.host?.size?.();
  return { width: size?.width || 0, height: size?.height || 0 };
}

/** Whether Google 3D tiles are the surface shown (the globe is hidden). */
const tilesShown = (engine) => engine?.maps?.photorealActive?.() === true;

/** Equirectangular metres between {lon, lat} points, the short way round ±180°; street scale. */
export function metresBetween(a, b) {
  const lat = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  return Math.hypot(
    wrapLon(b.lon - a.lon) * 111_320 * Math.cos(lat),
    (b.lat - a.lat) * 110_540,
  );
}

/** Whether a height (m) is plausible ellipsoidal land: Dead Sea to Everest, with geoid slack. */
export function plausibleSurfaceHeight(height) {
  return Number.isFinite(height) && height >= -500 && height <= 9000;
}

/**
 * Height (m) of the rendered surface, 3D tiles included, at `carto`; null
 * when unsampleable or implausible (`sampleHeight` reads kilometres
 * underground before tiles load).
 */
export function sampledSurfaceHeight(engine, carto) {
  return readSurface(engine, carto, { prefer: 'tiles' }) ?? null;
}

/** Height (m) of the terrain at `carto`, or null. */
export function terrainSurfaceHeight(engine, carto) {
  return readSurface(engine, carto, { prefer: 'terrain' }) ?? null;
}

/**
 * Ellipsoidal height (m) of the ground under the camera, or null. Under
 * Google 3D (globe hidden) the rendered surface counts, minus any roof above
 * the camera.
 */
export function groundUnderCamera(view) {
  const engine = engineOf(view);
  const carto = cameraLocation(view);
  if (!carto) return null;
  if (!tilesShown(engine)) {
    const ground = terrainSurfaceHeight(engine, carto);
    if (ground !== null) return ground;
  }
  const sampled = sampledSurfaceHeight(engine, carto);
  return sampled !== null && sampled < carto.height ? sampled : null;
}

/** WGS84 raised by `height` metres (the ground at that height), else WGS84. */
function raisedEllipsoid(height) {
  const wgs84 = geo.ellipsoid.WGS84;
  if (!Number.isFinite(height) || Math.abs(height) < 1)
    return { ellipsoid: wgs84, height: 0 };
  const { x, y, z } = wgs84.radii;
  return {
    ellipsoid: geo.ellipsoid.create(x + height, y + height, z + height),
    height,
  };
}

/**
 * Where a screen point's ray meets the ground, as a Cartographic, or null.
 * `maxRange` (metres from the camera) drops hits near the horizon.
 */
function groundHit(engine, point, { ellipsoid, height }, maxRange) {
  let cartesian = null;
  try {
    const { origin, direction } = engine.camera.pickRay(point);
    cartesian = intersectEllipsoid(origin, direction, height);
  } catch {
    cartesian = null;
  }
  if (!cartesian) return null;
  if (
    Number.isFinite(maxRange) &&
    geo.cartesian3.distance(cartesian, engine.camera.livePosition) > maxRange
  )
    return null;
  return geo.cartographic.fromCartesian(cartesian, ellipsoid) || null;
}

/** Camera height (m) above the ground under it. */
export function cameraHeightAboveGround(view) {
  const carto = cameraLocation(view);
  if (!carto) return null;
  return carto.height - (groundUnderCamera(view) ?? 0);
}

/** Screen rays per side, less one, that `visibleBbox` casts. */
const BBOX_GRID = 5;

/**
 * Visible [west, south, east, north] degrees from the rays that hit the
 * ground, or null when fewer than four do. `groundHeight` raises the ellipsoid
 * to the ground (Denver is 1,600 m up); `maxRange` (m) drops far hits.
 */
export function visibleBbox(
  view,
  { groundHeight = null, maxRange = null } = {},
) {
  const engine = engineOf(view);
  if (!engine) return null;
  const { width, height } = canvasSize(view);
  const hits = [];
  if (width > 0 && height > 0) {
    const ellipsoid = raisedEllipsoid(groundHeight);
    for (let i = 0; i <= BBOX_GRID; i++) {
      for (let j = 0; j <= BBOX_GRID; j++) {
        const carto = groundHit(
          engine,
          { x: (width * i) / BBOX_GRID, y: (height * j) / BBOX_GRID },
          ellipsoid,
          maxRange,
        );
        if (carto) hits.push(carto);
      }
    }
  }
  if (hits.length >= 4) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const carto of hits) {
      const lon = geo.math.toDegrees(carto.longitude);
      const lat = geo.math.toDegrees(carto.latitude);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    // Hits on both sides of ±180° read as a box around the whole globe;
    // measured in 0–360° they are a narrow box across the date line, which
    // comes back as west > east (the convention tilesForBbox splits).
    if (east - west > 180) {
      let west360 = Infinity;
      let east360 = -Infinity;
      for (const carto of hits) {
        const lon = geo.math.toDegrees(carto.longitude);
        const shifted = lon < 0 ? lon + 360 : lon;
        west360 = Math.min(west360, shifted);
        east360 = Math.max(east360, shifted);
      }
      if (east360 - west360 < east - west) {
        west = west360 > 180 ? west360 - 360 : west360;
        east = east360 > 180 ? east360 - 360 : east360;
      }
    }
    if (west !== east && north - south > 0) return [west, south, east, north];
  }
  return null;
}

/** The point on the ground under the camera, as {lon, lat} degrees. */
export function cameraNadir(view) {
  const carto = cameraLocation(view);
  if (!carto) return null;
  return {
    lon: geo.math.toDegrees(carto.longitude),
    lat: geo.math.toDegrees(carto.latitude),
  };
}

/**
 * Where coverage tiles are ranked from: halfway between the nadir and the
 * screen centre's ground, or the nadir when that is out of `maxRange`.
 */
export function viewFocus(view, { groundHeight = null, maxRange = null } = {}) {
  const nadir = cameraNadir(view);
  const { width, height } = canvasSize(view);
  if (!nadir || !width || !height) return nadir;
  const hit = groundHit(
    engineOf(view),
    { x: width / 2, y: height / 2 },
    raisedEllipsoid(groundHeight),
    maxRange,
  );
  if (!hit) return nadir;
  const ahead = {
    lon: geo.math.toDegrees(hit.longitude),
    lat: geo.math.toDegrees(hit.latitude),
  };
  return {
    lon: wrapLon(nadir.lon + wrapLon(ahead.lon - nadir.lon) / 2),
    lat: (nadir.lat + ahead.lat) / 2,
  };
}

/** The middle of the visible ground, else the point under the camera; null without a camera. */
export function viewCentre(view) {
  if (!engineOf(view)) return null;
  const bbox = visibleBbox(view);
  if (bbox) {
    // Across the date line (west > east) the middle is on the far side of 0°.
    const span = bbox[2] - bbox[0] + (bbox[0] > bbox[2] ? 360 : 0);
    let lon = bbox[0] + span / 2;
    if (lon > 180) lon -= 360;
    return { lat: (bbox[1] + bbox[3]) / 2, lon };
  }
  return cameraNadir(view);
}
