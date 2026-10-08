import * as Cesium from 'cesium';
import { wrapLon } from './tileMath.js';

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
export function sampledSurfaceHeight(scene, carto) {
  let height = null;
  try {
    if (scene?.sampleHeightSupported) height = scene.sampleHeight(carto);
  } catch {
    /* not sampleable yet */
  }
  return plausibleSurfaceHeight(height) ? height : null;
}

/**
 * Ellipsoidal height (m) of the ground under the camera, or null. The globe
 * answers where shown; Google 3D hides it, so the rendered surface does
 * (roofs count: a building's height at most). A sample above the camera is
 * ignored: a raised ground would put the camera underground.
 */
export function groundUnderCamera(viewer) {
  const carto = viewer?.camera?.positionCartographic;
  const scene = viewer?.scene;
  if (!carto || !scene) return null;
  const globe = scene.globe;
  if (globe && globe.show !== false) {
    const ground = globe.getHeight?.(carto);
    if (Number.isFinite(ground)) return ground;
  }
  const sampled = sampledSurfaceHeight(scene, carto);
  return sampled !== null && sampled < carto.height ? sampled : null;
}

/** The ellipsoid `height` metres above `ellipsoid` (the ground at that height). */
function raisedEllipsoid(ellipsoid, height) {
  if (!Number.isFinite(height) || Math.abs(height) < 1) return ellipsoid;
  const { x, y, z } = ellipsoid.radii;
  return new Cesium.Ellipsoid(x + height, y + height, z + height);
}

/**
 * Where a screen point's ray meets the ground, as a Cartographic, or null.
 * `maxRange` (metres from the camera) drops hits near the horizon.
 */
function groundHit(camera, point, ellipsoid, maxRange) {
  let cartesian = null;
  try {
    cartesian = camera.pickEllipsoid(point, ellipsoid);
  } catch {
    cartesian = null;
  }
  if (!cartesian) return null;
  if (
    Number.isFinite(maxRange) &&
    camera.positionWC &&
    Cesium.Cartesian3.distance(cartesian, camera.positionWC) > maxRange
  )
    return null;
  return Cesium.Cartographic.fromCartesian(cartesian, ellipsoid) || null;
}

/**
 * Visible [west, south, east, north] degrees, or null. Only screen rays that
 * hit count, so a horizon cannot inflate the box to the world.
 * `groundHeight` raises the ellipsoid to the ground (rays to the bare
 * ellipsoid under Denver land kilometres too far out) and `maxRange` (m)
 * drops near-horizon hits; with it, too few hits give null rather than
 * Cesium's view rectangle, which can span the horizon.
 */
export function visibleBbox(
  viewer,
  { grid = 5, groundHeight = null, maxRange = null } = {},
) {
  const scene = viewer?.scene;
  const camera = viewer?.camera;
  if (!scene || !camera) return null;
  const width = scene.canvas?.clientWidth || scene.canvas?.width || 0;
  const height = scene.canvas?.clientHeight || scene.canvas?.height || 0;
  const hits = [];
  if (width > 0 && height > 0) {
    const ellipsoid = raisedEllipsoid(
      scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84,
      groundHeight,
    );
    const point = new Cesium.Cartesian2();
    for (let i = 0; i <= grid; i++) {
      for (let j = 0; j <= grid; j++) {
        point.x = (width * i) / grid;
        point.y = (height * j) / grid;
        const carto = groundHit(camera, point, ellipsoid, maxRange);
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
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const lat = Cesium.Math.toDegrees(carto.latitude);
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
        const lon = Cesium.Math.toDegrees(carto.longitude);
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
  if (Number.isFinite(maxRange)) return null;
  const rectangle = camera.computeViewRectangle?.(scene.globe?.ellipsoid);
  if (!rectangle) return null;
  return [
    Cesium.Math.toDegrees(rectangle.west),
    Cesium.Math.toDegrees(rectangle.south),
    Cesium.Math.toDegrees(rectangle.east),
    Cesium.Math.toDegrees(rectangle.north),
  ];
}

/** The point on the ground under the camera, as {lon, lat} degrees. */
export function cameraNadir(viewer) {
  const carto = viewer?.camera?.positionCartographic;
  if (!carto) return null;
  return {
    lon: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude),
  };
}

/**
 * Where coverage tiles are ranked from: halfway between the ground under the
 * camera and the ground at the centre of the screen, so a tilted view loads
 * what it looks at as well as what is near. The nadir when the centre ray
 * misses the ground within `maxRange`. Options as `visibleBbox`.
 */
export function viewFocus(
  viewer,
  { groundHeight = null, maxRange = null } = {},
) {
  const nadir = cameraNadir(viewer);
  const scene = viewer?.scene;
  const width = scene?.canvas?.clientWidth || scene?.canvas?.width || 0;
  const height = scene?.canvas?.clientHeight || scene?.canvas?.height || 0;
  if (!nadir || !width || !height) return nadir;
  const hit = groundHit(
    viewer.camera,
    new Cesium.Cartesian2(width / 2, height / 2),
    raisedEllipsoid(
      scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84,
      groundHeight,
    ),
    maxRange,
  );
  if (!hit) return nadir;
  const ahead = {
    lon: Cesium.Math.toDegrees(hit.longitude),
    lat: Cesium.Math.toDegrees(hit.latitude),
  };
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
const HORIZON_CULL_ELLIPSOID = new Cesium.Ellipsoid(
  Cesium.Ellipsoid.WGS84.radii.x - HORIZON_CULL_DEPTH_M,
  Cesium.Ellipsoid.WGS84.radii.y - HORIZON_CULL_DEPTH_M,
  Cesium.Ellipsoid.WGS84.radii.z - HORIZON_CULL_DEPTH_M,
);

/**
 * Hide billboards and points behind the horizon: they skip the depth test, so
 * nothing else stops the far side drawing through the globe. Re-culls on
 * pre-render after the camera moves; stops when nothing is left to cull.
 * @param {{getViewer: () => object|null, items: () => Iterable<{position: object, show: boolean}>, onChange?: () => void}} options
 */
export function createHorizonCull({ getViewer, items, onChange }) {
  const occluder = new Cesium.EllipsoidalOccluder(HORIZON_CULL_ELLIPSOID);
  let from = null;
  let stopListening = null;

  /** Show what is in front of the horizon, hide the rest; the count seen. */
  function cull(list, position) {
    occluder.cameraPosition = position;
    let seen = 0;
    let changed = false;
    for (const item of list) {
      seen++;
      const show = occluder.isPointVisible(item.position);
      if (item.show !== show) {
        item.show = show;
        changed = true;
      }
    }
    if (changed) onChange?.();
    return seen;
  }

  /** Cull everything from the camera at `position`; the count seen. */
  function cullAll(position) {
    from = Cesium.Cartesian3.clone(position, from);
    return cull(items(), position);
  }

  function onPreRender() {
    const position = getViewer()?.camera?.positionWC;
    if (!position || (from && Cesium.Cartesian3.equals(from, position))) return;
    if (!cullAll(position)) stop();
  }

  /** Cull `added` items (or all) now, then all again whenever the camera moves. */
  function update(added) {
    const viewer = getViewer();
    const position = viewer?.camera?.positionWC;
    if (position && !(added ? cull(added, position) : cullAll(position)))
      return;
    stopListening ||=
      viewer?.scene?.preRender?.addEventListener(onPreRender) || null;
  }

  function stop() {
    stopListening?.();
    stopListening = null;
    from = null;
  }

  return { update, stop };
}
