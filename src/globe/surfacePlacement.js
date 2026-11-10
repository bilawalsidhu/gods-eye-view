// Stands map points on the rendered surface (tiles, else terrain), the same
// on every engine: the contract has no ground clamp. On the globe that
// surface is the terrain, read from its loaded tiles; only 3D tiles, which
// hide the globe, need sampleHeight, a pick render on Cesium. Only points
// on screen are measured, a few per pass, as a layer can hold thousands.
// They are measured again after each camera move and once the surface's
// tiles have loaded; a point whose height holds is not written again, so a
// parked camera asks for no frames.

import * as geo from '../geo/index.js';
import { acceptedSurfaceHeight } from './surfaceDetail.js';

const SAMPLES_PER_PASS = 16;
const SAMPLE_BUDGET_MS = 4;
const HEIGHT_EPSILON_M = 0.01;
// A point not placed yet projects from the ellipsoid, away from where it
// will stand: the screen test takes this much of the view around it too.
const SCREEN_MARGIN = 0.25;

// Dead Sea to Everest, with geoid slack: Cesium samples kilometres
// underground while tiles stream.
const plausible = (height) =>
  Number.isFinite(height) && height >= -500 && height <= 9000;

/** Read the visible surface, or an explicitly requested terrain/mesh floor.
 * `scene` retains callers that include roofs even on a terrain map; `tiles`
 * requires a mesh hit. `sceneFloor` keeps the terrain below a scene hit.
 * A finite tile-size limit also rejects coarse mesh LOD. `minHeight` preserves
 * consumers that intentionally admit coarse below-sea-level terrain.
 */
export function readSurface(
  engine,
  cartographic,
  { exclude = [], prefer, maxTileSizeM = Infinity, minHeight = -500 } = {},
) {
  const valid = (height) =>
    Number.isFinite(height) && height >= minHeight && height <= 9000;
  const surface = engine?.surface;
  if (!surface || !cartographic) return undefined;
  const tiles = engine.maps?.photorealActive?.() === true;
  if (
    prefer !== 'terrain' &&
    (tiles ||
      prefer === 'scene' ||
      prefer === 'sceneFloor' ||
      prefer === 'tiles')
  ) {
    let height;
    try {
      if (Number.isFinite(maxTileSizeM))
        height = acceptedSurfaceHeight(
          surface.sampleHeightDetailed(cartographic, { exclude }),
          { maxTileSizeM },
        );
      else if (surface.supported !== false)
        height = surface.sampleHeight(cartographic, exclude);
    } catch {
      // A streaming or retiring surface may not answer yet.
    }
    if (valid(height)) {
      if (prefer === 'sceneFloor' && !tiles) {
        const terrain = readSurface(engine, cartographic, {
          prefer: 'terrain',
        });
        return terrain === undefined ? height : Math.max(height, terrain);
      }
      return height;
    }
    if (prefer === 'tiles') return undefined;
  }
  try {
    const height =
      surface.terrainHeightSupported !== false
        ? surface.terrainHeight(cartographic)
        : undefined;
    return valid(height) ? height : undefined;
  } catch {
    return undefined;
  }
}

/** Subscribe once to camera rest and changes to the rendered ground. */
export function surfaceTriggers(engine, onChange) {
  let loaded = engine.surface.tilesLoaded();
  let tiles = engine.maps?.photorealActive?.() === true;
  let terrain = engine.maps?.terrainRevision?.();
  const removeMove = engine.camera.moveEnd.addEventListener(onChange);
  const removeFrame = engine.frames.preRender.addEventListener(() => {
    const nextLoaded = engine.surface.tilesLoaded();
    const nextTiles = engine.maps?.photorealActive?.() === true;
    const nextTerrain = engine.maps?.terrainRevision?.();
    const changed =
      (nextLoaded && !loaded) || nextTiles !== tiles || nextTerrain !== terrain;
    loaded = nextLoaded;
    tiles = nextTiles;
    terrain = nextTerrain;
    if (changed) onChange();
  });
  return () => {
    removeMove();
    removeFrame();
  };
}

/**
 * @param {import('./contract.js').GlobeEngine} engine
 * @param {object} options
 * @param {() => Iterable<{ set: object | null, points: object[], exclude?: object[] }>} options.groups
 *   Mover sets with the points they draw, point i as instance i, and what
 *   the samples skip (the set by default; a layer adds the rest it draws
 *   over the points). A point has `cartographic` and `position`, which a
 *   placement replaces (keeping the height in `surfaceHeight`); one with
 *   `show === false` is skipped.
 * @param {() => void} options.request Asks for a frame after a placement.
 * @param {number | ((point: object) => number)} [options.heightOffset=0] Metres above the surface.
 * @param {boolean} [options.estimateGround=false] Screen-test a point not
 *   measured yet on the loaded terrain (under 3D tiles without it, at the
 *   ground under the camera) rather than where it stands now.
 * @param {number} [options.screenMargin=0.25] Extra viewport fraction to measure.
 * @param {string | ((point: object) => string | undefined)} [options.prefer] Explicit height policy for readSurface.
 * @returns {{ place: (options?: { all?: boolean }) => void, destroy: () => void }}
 *   `place()` measures new points; `place({ all: true })` revisits every point.
 */
export function createSurfacePoints(
  engine,
  {
    groups,
    request,
    heightOffset = 0,
    estimateGround = false,
    screenMargin = SCREEN_MARGIN,
    prefer,
  },
) {
  let revision = 0;
  let timer = null;
  let destroyed = false;
  // Placements in one task (two triggers at once) share one sample budget.
  let taskSamples = 0;
  let taskCounted = false;

  function onScreen(position, size) {
    if (screenMargin === Infinity) return true;
    const screen = engine.projector.worldToWindow(position);
    const x = size.width * screenMargin;
    const y = size.height * screenMargin;
    return (
      screen &&
      screen.x >= -x &&
      screen.y >= -y &&
      screen.x < size.width + x &&
      screen.y < size.height + y
    );
  }

  // Under 3D tiles Cesium hides the globe, which then loads no terrain: the
  // ground under the camera stands in for it in the screen test.
  function groundUnderCamera(exclude) {
    const height = engine.surface.sampleHeight(
      geo.cartographic.fromCartesian(engine.camera.livePosition),
      exclude,
    );
    return plausible(height) ? height : Number.NaN;
  }

  // A pass continued by its own timer starts a new task's budget.
  function continuePlacing() {
    taskSamples = 0;
    place();
  }

  // Points off screen are passed over until the next move or tile load.
  function place({ all = false } = {}) {
    if (all) revision++;
    clearTimeout(timer);
    timer = null;
    if (destroyed) return;
    const size = engine.host.size();
    const tiles = engine.maps?.photorealActive?.() === true;
    const started = performance.now();
    if (!taskCounted) {
      taskCounted = true;
      queueMicrotask(() => {
        taskSamples = 0;
        taskCounted = false;
      });
    }
    let samples = taskSamples;
    let visited = 0;
    let moved = false;
    let cameraGround;
    for (const { set, points, exclude = [set] } of groups()) {
      if (!set) continue;
      let changed = false;
      const yieldPass = () => {
        if (changed) set.commit();
        if (changed || moved) request();
        timer = setTimeout(continuePlacing, 0);
      };
      for (let index = 0; index < points.length; index++) {
        const point = points[index];
        if (point.surfaceRevision === revision) continue;
        if (
          samples >= SAMPLES_PER_PASS ||
          (visited > 0 && performance.now() - started >= SAMPLE_BUDGET_MS)
        ) {
          yieldPass();
          return;
        }
        visited++;
        const previousRevision = point.surfaceRevision;
        point.surfaceRevision = revision;
        if (point.show === false) continue;
        const offset =
          typeof heightOffset === 'function'
            ? heightOffset(point)
            : heightOffset;
        const estimate = estimateGround && point.surfaceHeight === undefined;
        const terrain = estimate
          ? readSurface(engine, point.cartographic, { prefer: 'terrain' })
          : undefined;
        let ground = terrain;
        if (estimate && tiles && !plausible(ground)) {
          if (cameraGround === undefined) {
            samples++;
            taskSamples = samples;
            cameraGround = groundUnderCamera(exclude);
          }
          ground = cameraGround;
        }
        const position = plausible(ground)
          ? geo.cartesian3.fromRadians(
              point.cartographic.longitude,
              point.cartographic.latitude,
              ground + offset,
            )
          : point.position;
        if (!onScreen(position, size)) continue;
        // The camera estimate and the work since the check above count too:
        // leave this point for the next pass rather than go over the budget.
        if (
          samples >= SAMPLES_PER_PASS ||
          (samples > 0 && performance.now() - started >= SAMPLE_BUDGET_MS)
        ) {
          point.surfaceRevision = previousRevision;
          yieldPass();
          return;
        }
        samples++;
        taskSamples = samples;
        const height = readSurface(engine, point.cartographic, {
          exclude,
          prefer: typeof prefer === 'function' ? prefer(point) : prefer,
        });
        if (!plausible(height)) continue;
        if (Math.abs(height - point.surfaceHeight) < HEIGHT_EPSILON_M) continue;
        point.surfaceHeight = height;
        point.position = geo.cartesian3.fromRadians(
          point.cartographic.longitude,
          point.cartographic.latitude,
          height + offset,
        );
        set.set(index, { position: point.position });
        changed = true;
      }
      if (changed) set.commit();
      moved ||= changed;
    }
    if (moved) request();
  }

  const removeSurface = surfaceTriggers(engine, () => place({ all: true }));

  return {
    place,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(timer);
      removeSurface();
    },
  };
}
