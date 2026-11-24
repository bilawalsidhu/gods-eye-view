/**
 * @module render/cesium/imageryLookAhead
 * @description Pre-loads the globe imagery a narrow, nadir-looking, moving
 * camera is about to pass over.
 *
 * A view 10 to 40 km wide carried along an orbit (about 7 km/s over the
 * ground) outruns the imagery under it. The renderer watches its own
 * camera: once the vertical field of view is as narrow as an orbital view
 * at 16x (`ORBITAL_PREFETCH_MIN_ZOOM`) for the camera's height, the camera
 * looks straight down and it moves over the ground, it asks the globe's
 * base imagery every ORBITAL_PREFETCH_INTERVAL_MS for the tiles the view
 * will need 5 to 20 s ahead (`groundTrackAhead`), at the level Cesium will
 * draw there (`imageryLevelForView`), so the browser has them cached when
 * the view gets there.
 *
 * The requests are throttled at the lowest priority: Cesium's request
 * scheduler declines one while the imagery server's slots are taken by the
 * tiles on screen or the scheduler is full, and a declined tile is asked
 * again on a later look-ahead. At most ORBITAL_PREFETCH_MAX_TILES a time;
 * the last PREFETCH_MEMORY tiles asked for are not asked again unless their
 * request was dropped, and a new base map starts the memory over. When the
 * view widens again the requests still pending are cancelled and the memory
 * starts over. Nothing while the camera is tilted off nadir, with the scene
 * clock away from now (paused, played back), with the camera still, or with
 * the globe hidden (Google 3D tiles drawn instead).
 */
import * as Cesium from 'cesium';
import {
  ORBITAL_EARTH_RADIUS_M,
  ORBITAL_PREFETCH_INTERVAL_MS,
  ORBITAL_PREFETCH_MAX_TILES,
  ORBITAL_PREFETCH_MIN_ZOOM,
  centreLinesFirst,
  footprintWidthKm,
  fovForZoom,
  groundTrackAhead,
  imageryLevelForView,
  orbitalBaseFovRad,
  tilesForPoints,
} from '../../cockpitOrbital.js';

/** Tiles remembered as asked for while the view stays narrow. */
const PREFETCH_MEMORY = 512;

/** How far the scene clock may be from now for the look-ahead to run, ms. */
const PREFETCH_LIVE_TOLERANCE_MS = 60_000;

/** The camera's look may stray this far from straight down, radians. */
const NADIR_TOLERANCE_RAD = (0.5 * Math.PI) / 180;

/** Slower over the ground than this, m/s, the camera is not carried along. */
const MIN_GROUND_SPEED_MPS = 100;

/** The camera's motion is measured over at least this long, ms. */
const MOTION_SAMPLE_MS = 250;

/** A motion measured longer ago than this is no longer trusted, ms. */
const MOTION_MAX_AGE_MS = 2 * ORBITAL_PREFETCH_INTERVAL_MS;

const toRadians = (deg) => (deg * Math.PI) / 180;
const toDegrees = (rad) => (rad * 180) / Math.PI;

/**
 * The provider of the lowest shown imagery layer, the base map the globe
 * drapes, when it can be asked for a tile; else null.
 */
function baseImageryProvider(viewer) {
  const layers = viewer.imageryLayers ?? viewer.scene?.imageryLayers;
  const count = Number.isInteger(layers?.length) ? layers.length : 0;
  for (let i = 0; i < count; i += 1) {
    const layer = layers.get(i);
    if (!layer || layer.show === false || layer.alpha === 0) continue;
    const provider = layer.imageryProvider;
    if (
      typeof provider?.requestImage === 'function' &&
      typeof provider.tilingScheme?.positionToTileXY === 'function'
    )
      return provider;
    return null;
  }
  return null;
}

/** Great-circle distance, m, and initial bearing, degrees, between points. */
function groundMove(from, to) {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const dLat = lat2 - lat1;
  const dLon = toRadians(to.lon - from.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const distanceM =
    2 * ORBITAL_EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
  const bearingDeg = toDegrees(
    Math.atan2(
      Math.sin(dLon) * Math.cos(lat2),
      Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon),
    ),
  );
  return { distanceM, bearingDeg };
}

/** True when the camera looks straight down at the point below it. */
function looksAtNadir(camera) {
  const position = camera.positionWC ?? camera.position;
  const direction = camera.directionWC ?? camera.direction;
  if (!position || !direction) return false;
  const r = Math.hypot(position.x, position.y, position.z);
  const d = Math.hypot(direction.x, direction.y, direction.z);
  if (!(r > 0) || !(d > 0)) return false;
  const cos =
    -(
      position.x * direction.x +
      position.y * direction.y +
      position.z * direction.z
    ) /
    (r * d);
  return cos >= Math.cos(NADIR_TOLERANCE_RAD);
}

/**
 * Watch the camera each frame and pre-load the imagery ahead of a narrow,
 * nadir-looking, moving view.
 * @param {object} viewer Cesium viewer.
 * @param {{now?: () => number}} [options] `now` is the wall clock, ms.
 * @returns {{update: (nowMs?: number) => number, destroy: () => void}}
 *   `update` runs one frame's check and returns the tiles asked for; the
 *   viewer's postRender calls it.
 */
export function preloadImageryAhead(viewer, { now = () => Date.now() } = {}) {
  let active = false;
  let lastAskMs = -Infinity;
  let anchor = null;
  let motion = null;
  let provider = null;
  let memory = new Set();
  let requests = new Set();

  const cancelPending = () => {
    for (const request of requests) request.cancel?.();
    requests = new Set();
  };

  const deactivate = () => {
    if (!active) return;
    active = false;
    cancelPending();
    memory = new Set();
    provider = null;
    lastAskMs = -Infinity;
  };

  /** Measure the camera's motion over the ground from its own positions. */
  const sampleMotion = (cartographic, nowMs) => {
    const point = {
      lat: toDegrees(cartographic.latitude),
      lon: toDegrees(cartographic.longitude),
      ms: nowMs,
    };
    if (!anchor || nowMs < anchor.ms) {
      anchor = point;
      return;
    }
    const elapsedMs = nowMs - anchor.ms;
    if (elapsedMs < MOTION_SAMPLE_MS) return;
    const { distanceM, bearingDeg } = groundMove(anchor, point);
    motion = {
      groundMps: (distanceM * 1000) / elapsedMs,
      bearingDeg,
      ms: nowMs,
    };
    anchor = point;
  };

  const update = (nowMs = now()) => {
    try {
      const { scene, camera } = viewer;
      const cartographic = camera?.positionCartographic;
      const altitudeM = cartographic?.height;
      const fovy = camera?.frustum?.fovy;
      if (
        !cartographic ||
        !(altitudeM > 0) ||
        !Number.isFinite(fovy) ||
        (scene?.mode !== undefined && scene.mode !== Cesium.SceneMode.SCENE3D)
      ) {
        deactivate();
        return 0;
      }
      sampleMotion(cartographic, nowMs);
      const threshold = fovForZoom(
        orbitalBaseFovRad(altitudeM),
        ORBITAL_PREFETCH_MIN_ZOOM,
      );
      if (!(fovy <= threshold * (1 + 1e-6))) {
        deactivate();
        return 0;
      }
      active = true;
      // Tilted, the view looks off the track the pre-load follows.
      if (!looksAtNadir(camera)) return 0;
      if (nowMs - lastAskMs < ORBITAL_PREFETCH_INTERVAL_MS) return 0;
      // The look-ahead runs at live speed: with the scene clock paused,
      // played back or moved, the view will not pass where it points.
      const sceneTime = viewer.clock?.currentTime;
      if (sceneTime) {
        const sceneMs = Cesium.JulianDate.toDate(sceneTime).getTime();
        if (Math.abs(sceneMs - Date.now()) > PREFETCH_LIVE_TOLERANCE_MS)
          return 0;
      }
      if (
        !motion ||
        nowMs - motion.ms > MOTION_MAX_AGE_MS ||
        !(motion.groundMps >= MIN_GROUND_SPEED_MPS)
      )
        return 0;
      lastAskMs = nowMs;
      const globe = scene?.globe;
      if (!globe || globe.show === false) return 0;
      const base = baseImageryProvider(viewer);
      if (!base) return 0;
      // Another base map: its tiles have not been asked for. A fresh set,
      // so a late failure from the old map's requests cannot drop a tile
      // the new one has fetched.
      if (base !== provider) {
        cancelPending();
        memory = new Set();
        provider = base;
      }
      const aspect = Number.isFinite(camera.frustum.aspectRatio)
        ? camera.frustum.aspectRatio
        : 1;
      const viewKm = footprintWidthKm(altitudeM, fovy, aspect);
      // The ground one CSS pixel covers at the nadir point, as Cesium's
      // screen-space error measures it: the vertical field of view over the
      // canvas height, at the camera's altitude.
      const canvas = scene.canvas;
      const heightPx = canvas?.clientHeight || canvas?.height;
      const terrain = viewer.terrainProvider ?? globe.terrainProvider;
      const level = imageryLevelForView(base.tilingScheme, {
        metresPerPixel: (altitudeM * 2 * Math.tan(fovy / 2)) / heightPx,
        latitudeDeg: toDegrees(cartographic.latitude),
        geographic:
          base.tilingScheme.projection instanceof Cesium.GeographicProjection,
        tileWidthPx: base.tileWidth,
        minimumLevel: base.minimumLevel,
        maximumLevel: base.maximumLevel,
        maximumScreenSpaceError: globe.maximumScreenSpaceError,
        terrainLevelErrorM:
          typeof terrain?.getLevelMaximumGeometricError === 'function'
            ? (terrainLevel) =>
                terrain.getLevelMaximumGeometricError(terrainLevel)
            : undefined,
      });
      if (level === null) return 0;
      const R = ORBITAL_EARTH_RADIUS_M;
      const track = {
        latitude: toDegrees(cartographic.latitude),
        longitude: toDegrees(cartographic.longitude),
        groundTrackDeg: motion.bearingDeg,
        // groundTrackAhead scales an orbital speed down to the ground.
        velocityMps: (motion.groundMps * (R + altitudeM)) / R,
        altitudeM,
      };
      const remembered = memory;
      const pending = requests;
      const tiles = tilesForPoints(
        base.tilingScheme,
        centreLinesFirst(groundTrackAhead(track, viewKm)),
        level,
        {
          maxTiles: ORBITAL_PREFETCH_MAX_TILES,
          skip: (key) => remembered.has(key),
        },
      );
      let asked = 0;
      for (const tile of tiles) {
        let promise;
        let request;
        try {
          // The tiles on screen keep their slots: Cesium's scheduler
          // declines this request while the imagery server's slots are
          // taken (shared with the globe's own tile requests,
          // throttleByServer) or the scheduler is full, and at the lowest
          // priority it is the first dropped from the priority heap, never
          // one the screen asked for.
          promise = base.requestImage(
            tile.x,
            tile.y,
            tile.level,
            (request = new Cesium.Request({
              throttle: true,
              throttleByServer: true,
              priority: Number.MAX_VALUE,
              type: Cesium.RequestType.IMAGERY,
            })),
          );
        } catch {
          continue;
        }
        // A provider that declines now (throttled) is asked again later.
        if (!promise) continue;
        pending.add(request);
        Promise.resolve(promise).then(
          () => pending.delete(request),
          (error) => {
            pending.delete(request);
            // Dropped by the scheduler (rejected with no error): asked
            // again later. A tile that failed to load stays remembered, so
            // one missing from the map is not asked for every look-ahead.
            if (error === undefined) remembered.delete(tile.key);
          },
        );
        remembered.add(tile.key);
        if (remembered.size > PREFETCH_MEMORY)
          remembered.delete(remembered.values().next().value);
        asked += 1;
      }
      return asked;
    } catch {
      return 0;
    }
  };

  const remove = viewer.scene?.postRender?.addEventListener?.(() => update());
  return {
    update,
    destroy() {
      remove?.();
      deactivate();
    },
  };
}
