import * as Cesium from 'cesium';

/**
 * Camera height above the surface under the camera, in metres. The globe's
 * terrain answers when the globe is shown; Google 3D hides the globe, so
 * there the bare-earth height from `groundAt(lon, lat)` answers instead
 * (without it a camera over a city 1,600 m up reads 1,600 m too high). Falls
 * back to the ellipsoidal height when neither has a sample yet.
 * @param {object} viewer
 * @param {{groundAt?: (lon: number, lat: number) => number|null}} [options]
 */
export function cameraHeightAboveGround(viewer, { groundAt } = {}) {
  const carto = viewer?.camera?.positionCartographic;
  if (!carto) return null;
  const globe = viewer.scene?.globe;
  let ground = globe?.show === false ? null : globe?.getHeight?.(carto);
  if (!Number.isFinite(ground))
    ground = groundAt?.(
      Cesium.Math.toDegrees(carto.longitude),
      Cesium.Math.toDegrees(carto.latitude),
    );
  return carto.height - (Number.isFinite(ground) ? ground : 0);
}

/**
 * Visible bbox as [west, south, east, north] degrees, or null when the camera
 * does not see the ground. A grid of screen rays is cast onto the ellipsoid
 * and only the rays that hit count, so a view that includes the horizon (or a
 * canvas whose frustum is stale) cannot inflate the box to the whole world;
 * `computeViewRectangle` is the fallback when too few rays land.
 */
export function visibleBbox(viewer, { grid = 5 } = {}) {
  const scene = viewer?.scene;
  const camera = viewer?.camera;
  if (!scene || !camera) return null;
  const width = scene.canvas?.clientWidth || scene.canvas?.width || 0;
  const height = scene.canvas?.clientHeight || scene.canvas?.height || 0;
  const hits = [];
  if (width > 0 && height > 0) {
    const ellipsoid = scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84;
    const point = new Cesium.Cartesian2();
    for (let i = 0; i <= grid; i++) {
      for (let j = 0; j <= grid; j++) {
        point.x = (width * i) / grid;
        point.y = (height * j) / grid;
        let cartesian = null;
        try {
          cartesian = camera.pickEllipsoid(point, ellipsoid);
        } catch {
          cartesian = null;
        }
        if (!cartesian) continue;
        const carto = Cesium.Cartographic.fromCartesian(cartesian, ellipsoid);
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
  const rectangle = camera.computeViewRectangle?.(scene.globe?.ellipsoid);
  if (!rectangle) return null;
  return [
    Cesium.Math.toDegrees(rectangle.west),
    Cesium.Math.toDegrees(rectangle.south),
    Cesium.Math.toDegrees(rectangle.east),
    Cesium.Math.toDegrees(rectangle.north),
  ];
}

/** Centre of the visible ground, or the camera's own footprint. */
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
  const carto = viewer.camera?.positionCartographic;
  if (!carto) return null;
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
  };
}
