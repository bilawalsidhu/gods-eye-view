// Stands map points on the rendered surface (tiles, else terrain), the same
// on every engine: the contract has no ground clamp. On the globe that
// surface is the terrain, read from its loaded tiles; only 3D tiles, which
// hide the globe, need sampleHeight, a pick render on Cesium. Only points
// on screen are measured, a few per pass, as a layer can hold thousands.
// They are measured again after each camera move and once the surface's
// tiles have loaded; a point whose height holds is not written again, so a
// parked camera asks for no frames.

import * as geo from '../../../geo/index.js';

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

/**
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {object} options
 * @param {() => Iterable<{ set: object | null, points: object[], exclude?: object[] }>} options.groups
 *   Mover sets with the points they draw, point i as instance i, and what
 *   the samples skip (the set by default; a layer adds the rest it draws
 *   over the points). A point has `cartographic` and `position`, which a
 *   placement replaces (keeping the height in `surfaceHeight`); one with
 *   `show === false` is skipped.
 * @param {() => void} options.request Asks for a frame after a placement.
 * @param {number} [options.heightOffset=0] Metres above the surface.
 * @param {boolean} [options.estimateGround=false] Screen-test a point not
 *   measured yet on the loaded terrain (under 3D tiles without it, at the
 *   ground under the camera) rather than where it stands now.
 * @returns {{ place: () => void, destroy: () => void }} `place()` measures
 *   the points not yet placed on this surface (new points, for example).
 */
export function createSurfacePoints(
  engine,
  { groups, request, heightOffset = 0, estimateGround = false },
) {
  let revision = 0;
  let timer = null;
  let destroyed = false;
  let tilesLoaded = engine.surface.tilesLoaded();
  let photoreal = engine.maps?.photorealActive?.() === true;

  function onScreen(position, size) {
    const screen = engine.projector.worldToWindow(position);
    const x = size.width * SCREEN_MARGIN;
    const y = size.height * SCREEN_MARGIN;
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

  // Points off screen are passed over until the next move or tile load.
  function place() {
    clearTimeout(timer);
    timer = null;
    if (destroyed) return;
    const size = engine.host.size();
    const tiles = engine.maps?.photorealActive?.() === true;
    const started = performance.now();
    let samples = 0;
    let moved = false;
    let cameraGround;
    for (const { set, points, exclude = [set] } of groups()) {
      if (!set) continue;
      let changed = false;
      for (let index = 0; index < points.length; index++) {
        const point = points[index];
        if (point.surfaceRevision === revision) continue;
        if (
          samples >= SAMPLES_PER_PASS ||
          performance.now() - started >= SAMPLE_BUDGET_MS
        ) {
          if (changed) set.commit();
          if (changed || moved) request();
          timer = setTimeout(place, 0);
          return;
        }
        point.surfaceRevision = revision;
        if (point.show === false) continue;
        const estimate = estimateGround && point.surfaceHeight === undefined;
        const terrain = estimate
          ? engine.surface.terrainHeight(point.cartographic)
          : undefined;
        let ground = terrain;
        if (estimate && tiles && !plausible(ground)) {
          if (cameraGround === undefined) {
            samples++;
            cameraGround = groundUnderCamera(exclude);
          }
          ground = cameraGround;
        }
        const position = plausible(ground)
          ? geo.cartesian3.fromRadians(
              point.cartographic.longitude,
              point.cartographic.latitude,
              ground + heightOffset,
            )
          : point.position;
        if (!onScreen(position, size)) continue;
        samples++;
        let height = tiles
          ? engine.surface.sampleHeight(point.cartographic, exclude)
          : undefined;
        if (!plausible(height))
          height = terrain ?? engine.surface.terrainHeight(point.cartographic);
        if (!plausible(height)) continue;
        if (Math.abs(height - point.surfaceHeight) < HEIGHT_EPSILON_M) continue;
        point.surfaceHeight = height;
        point.position = geo.cartesian3.fromRadians(
          point.cartographic.longitude,
          point.cartographic.latitude,
          height + heightOffset,
        );
        set.set(index, { position: point.position });
        changed = true;
      }
      if (changed) set.commit();
      moved ||= changed;
    }
    if (moved) request();
  }

  function refine() {
    revision++;
    place();
  }
  const removeMoveEnd = engine.camera.moveEnd.addEventListener(refine);
  const removeFrame = engine.frames.preRender.addEventListener(() => {
    const loaded = engine.surface.tilesLoaded();
    const tiles = engine.maps?.photorealActive?.() === true;
    if ((loaded && !tilesLoaded) || tiles !== photoreal) refine();
    tilesLoaded = loaded;
    photoreal = tiles;
  });

  return {
    place,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(timer);
      removeMoveEnd();
      removeFrame();
    },
  };
}
