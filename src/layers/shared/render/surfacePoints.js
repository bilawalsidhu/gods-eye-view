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
 * @returns {{ place: () => void, destroy: () => void }} `place()` measures
 *   the points not yet placed on this surface (new points, for example).
 */
export function createSurfacePoints(engine, { groups, request }) {
  let revision = 0;
  let timer = null;
  let destroyed = false;
  let tilesLoaded = engine.surface.tilesLoaded();

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
        if (point.show === false || !onScreen(point.position, size)) continue;
        samples++;
        let height = tiles
          ? engine.surface.sampleHeight(point.cartographic, exclude)
          : undefined;
        if (!plausible(height))
          height = engine.surface.terrainHeight(point.cartographic);
        if (!plausible(height)) continue;
        if (Math.abs(height - point.surfaceHeight) < HEIGHT_EPSILON_M) continue;
        point.surfaceHeight = height;
        point.position = geo.cartesian3.fromRadians(
          point.cartographic.longitude,
          point.cartographic.latitude,
          height,
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
    if (loaded && !tilesLoaded) refine();
    tilesLoaded = loaded;
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
