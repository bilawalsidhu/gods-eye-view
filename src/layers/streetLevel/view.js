import { wrapLon } from './tileMath.js';
import {
  offsetEllipsoid,
  rayEllipsoid,
  toLonLatH,
  WGS84,
} from '../../geo/ellipsoid.js';
import { horizonFrom } from '../../geo/horizon.js';
import { distance } from '../../geo/vector.js';
import {
  findCamera,
  findFrame,
  findQuery,
  rendererOf,
} from '../../render/rendererOf.js';

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
 * Height (m) of the rendered surface, 3D tiles included, at `point`
 * (`{lon, lat}` degrees); null when unsampleable or implausible
 * (`sampleHeight` reads kilometres underground before tiles load).
 * `against: 'tiles'` reads the 3D tiles alone.
 */
export function sampledSurfaceHeight(viewer, point, { against } = {}) {
  const height =
    findQuery(viewer)?.sampleHeightNow(point, against ? { against } : {}) ??
    null;
  return plausibleSurfaceHeight(height) ? height : null;
}

/** The camera's pose, or null without one (or with no position). */
function poseOf(viewer) {
  if (!viewer) return null;
  const pose = findCamera(viewer)?.pose();
  return pose && Number.isFinite(pose.height) ? pose : null;
}

/**
 * Ellipsoidal height (m) of the ground under the camera, or null. Where 3D
 * tiles answer under the camera (Google 3D) they decide: their surface,
 * minus any roof above the camera, or null while they are still loading
 * (they read kilometres underground then). Elsewhere the loaded terrain,
 * else the drawn surface below the camera.
 */
export function groundUnderCamera(viewer) {
  const pose = poseOf(viewer);
  const query = pose && findQuery(viewer);
  if (!query) return null;
  const point = { lon: pose.lon, lat: pose.lat };
  const tiles = query.sampleHeightNow(point, { against: 'tiles' }) ?? null;
  if (tiles !== null)
    return plausibleSurfaceHeight(tiles) && tiles < pose.height ? tiles : null;
  const terrain = query.sampleHeightNow(point, { against: 'terrain' }) ?? null;
  if (Number.isFinite(terrain)) return terrain;
  const surface = sampledSurfaceHeight(viewer, point);
  return surface !== null && surface < pose.height ? surface : null;
}

/** The ellipsoid `height` metres above WGS84 (the ground at that height). */
function raisedEllipsoid(height) {
  if (!Number.isFinite(height) || Math.abs(height) < 1) return WGS84;
  return offsetEllipsoid(height);
}

/** The CSS size of the canvas the viewer draws on; zeros without one. */
export function canvasSize(viewer) {
  const canvas = rendererOf(viewer)?.canvas ?? viewer?.canvas;
  return {
    width: canvas?.clientWidth || canvas?.width || 0,
    height: canvas?.clientHeight || canvas?.height || 0,
  };
}

/**
 * Where a screen point's ray meets `ellipsoid`, as `{lon, lat}` degrees on
 * it, or null. `maxRange` (metres from the camera) drops hits near the
 * horizon.
 */
function groundHit(query, x, y, ellipsoid, maxRange) {
  let ray = null;
  try {
    ray = query.pickRay(x, y);
  } catch {
    ray = null;
  }
  const hit = ray?.origin && ray.direction && rayEllipsoid(ray, ellipsoid);
  if (!hit) return null;
  if (Number.isFinite(maxRange) && distance(hit, ray.origin) > maxRange)
    return null;
  return toLonLatH(hit, ellipsoid);
}

/** Camera height (m) above the ground under it. */
export function cameraHeightAboveGround(viewer) {
  const pose = poseOf(viewer);
  if (!pose) return null;
  return pose.height - (groundUnderCamera(viewer) ?? 0);
}

/** Screen rays per side, less one, that `visibleBbox` casts. */
const BBOX_GRID = 5;

/**
 * Visible [west, south, east, north] degrees from the rays that hit the
 * ground, or null when fewer than four do. `groundHeight` raises the ellipsoid
 * to the ground (Denver is 1,600 m up); `maxRange` (m) drops far hits.
 */
export function visibleBbox(
  viewer,
  { groundHeight = null, maxRange = null } = {},
) {
  const query = viewer && findQuery(viewer);
  if (!query || !poseOf(viewer)) return null;
  const { width, height } = canvasSize(viewer);
  const hits = [];
  if (width > 0 && height > 0) {
    const ellipsoid = raisedEllipsoid(groundHeight);
    for (let i = 0; i <= BBOX_GRID; i++) {
      for (let j = 0; j <= BBOX_GRID; j++) {
        const hit = groundHit(
          query,
          (width * i) / BBOX_GRID,
          (height * j) / BBOX_GRID,
          ellipsoid,
          maxRange,
        );
        if (hit) hits.push(hit);
      }
    }
  }
  if (hits.length >= 4) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const { lon, lat } of hits) {
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
      for (const { lon } of hits) {
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
export function cameraNadir(viewer) {
  const pose = poseOf(viewer);
  return pose ? { lon: pose.lon, lat: pose.lat } : null;
}

/**
 * Where coverage tiles are ranked from: halfway between the nadir and the
 * screen centre's ground, or the nadir when that is out of `maxRange`.
 */
export function viewFocus(
  viewer,
  { groundHeight = null, maxRange = null } = {},
) {
  const nadir = cameraNadir(viewer);
  const { width, height } = canvasSize(viewer);
  const query = nadir && findQuery(viewer);
  if (!nadir || !query || !width || !height) return nadir;
  const ahead = groundHit(
    query,
    width / 2,
    height / 2,
    raisedEllipsoid(groundHeight),
    maxRange,
  );
  if (!ahead) return nadir;
  return {
    lon: wrapLon(nadir.lon + wrapLon(ahead.lon - nadir.lon) / 2),
    lat: (nadir.lat + ahead.lat) / 2,
  };
}

/**
 * Horizon occluder depth below WGS84 (m): ground can lie below the ellipsoid
 * (NYC −22 m), and an occluder at 0 m would hide the cones around it.
 */
const HORIZON_CULL_DEPTH_M = 1000;
const HORIZON_CULL_ELLIPSOID = offsetEllipsoid(-HORIZON_CULL_DEPTH_M);

/**
 * Hide markers behind the horizon: they skip the depth test, so nothing
 * else stops the far side drawing through the globe. Re-culls before a
 * frame draws after the camera moves; stops when nothing is left to cull.
 * Items are `{position, show}` (`position` ECEF); `onChange` hears the
 * items whose `show` it changed.
 * @param {{getViewer: () => object|null, items: () => Iterable<{position: {x: number, y: number, z: number}, show: boolean}>, onChange?: (changed: object[]) => void}} options
 */
export function createHorizonCull({ getViewer, items, onChange }) {
  let from = null;
  let stopListening = null;

  /** Show what is in front of the horizon, hide the rest; the count seen. */
  function cull(list, position) {
    const horizon = horizonFrom(position, HORIZON_CULL_ELLIPSOID);
    let seen = 0;
    const changed = [];
    for (const item of list) {
      seen++;
      const show = horizon.isPointVisible(item.position);
      if (item.show !== show) {
        item.show = show;
        changed.push(item);
      }
    }
    if (changed.length) onChange?.(changed);
    return seen;
  }

  /** Cull everything from the camera at `position`; the count seen. */
  function cullAll(position) {
    from = { x: position.x, y: position.y, z: position.z };
    return cull(items(), position);
  }

  const eyeOf = (viewer) => (viewer ? poseOf(viewer)?.position : null) ?? null;
  const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;

  function onPreRender() {
    const position = eyeOf(getViewer());
    if (!position || (from && same(from, position))) return;
    if (!cullAll(position)) stop();
  }

  /** Cull `added` items (or all) now, then all again whenever the camera moves. */
  function update(added) {
    const viewer = getViewer();
    const position = eyeOf(viewer);
    if (position && !(added ? cull(added, position) : cullAll(position)))
      return;
    stopListening ||=
      (viewer && findFrame(viewer)?.on('preRender', onPreRender)) || null;
  }

  function stop() {
    stopListening?.();
    stopListening = null;
    from = null;
  }

  return { update, stop };
}

/** The middle of the visible ground, else the point under the camera; null without a camera. */
export function viewCentre(viewer) {
  if (!viewer) return null;
  const bbox = visibleBbox(viewer);
  if (bbox) {
    // Across the date line (west > east) the middle is on the far side of 0°.
    const span = bbox[2] - bbox[0] + (bbox[0] > bbox[2] ? 360 : 0);
    let lon = bbox[0] + span / 2;
    if (lon > 180) lon -= 360;
    return { lat: (bbox[1] + bbox[3]) / 2, lon };
  }
  const pose = poseOf(viewer);
  return pose ? { lat: pose.lat, lon: pose.lon } : null;
}
