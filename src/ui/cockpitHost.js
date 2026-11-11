import { readSurface } from '../globe/surfacePlacement.js';
// Camera and aircraft ownership used by the shared first-person controller,
// on the globe contract: the ridden aircraft is the engine follow's target,
// the aircraft display's tracked glyph handle.
import { routeViewerClick } from '../globe/cesium/orbital.js';
import { prefetchOrbitalImagery } from '../globe/cesium/orbitalImagery.js';
import { routeViewerDoubleClick } from '../globe/cesium/doubleClick.js';

/**
 * @param {import('../globe/contract.js').GlobeEngine} engine
 * @param {{ viewer?: object|null }} [options] `viewer`: Cesium's Viewer when
 *   the engine is Cesium. Its stock double-click would drop the follow, so
 *   the Cockpit's goes first; Navara has none to route around.
 */
export function cockpitHost(engine, { viewer = null } = {}) {
  let resumeInputs = null;
  const aircraft = () => {
    const target = engine.camera.following()?.native;
    return target?.resumeAircraftFollow ? target : null;
  };
  return {
    preUpdate: engine.frames.preUpdate,
    followChanged: engine.camera.followChanged,
    followed: aircraft,
    current: aircraft,
    contains: (target) => target.live,
    position: (target) => target.spec.position(),
    release: () => engine.camera.following()?.stop(),
    restore: (target) => target.resumeAircraftFollow(),
    camera: engine.camera,
    imageryReady: () =>
      engine.maps.photorealActive() || engine.surface.tilesLoaded(),
    cartographic: () => engine.camera.pose().cartographic,
    terrainHeight: (place) => readSurface(engine, place, { prefer: 'terrain' }),
    surface: engine,
    pick: (position) => engine.picker.pick(position),
    // A full mesh read is still Cesium's; the contract's detailed read is
    // loaded geometry only. Other engines combine it with full terrain.
    sampleWaterline(probes) {
      if (viewer?.scene.sampleHeightMostDetailed)
        return viewer.scene.sampleHeightMostDetailed(probes);
      return engine.surface.sampleTerrainMostDetailed(probes).then((terrain) =>
        probes.map((probe, index) => {
          const sample = engine.surface.sampleHeightDetailed(probe);
          return {
            height: sample?.source === 'tiles' ? sample.height : terrain[index],
          };
        }),
      );
    },
    // The cockpit holds the camera through a suspension of the user's
    // camera inputs: leaving it puts back whatever they were.
    inputs(enabled) {
      if (enabled) {
        resumeInputs?.();
        resumeInputs = null;
      } else resumeInputs ??= engine.input.suspendCameraInputs();
    },
    prefetchImagery: (state, info, fov, aspect) =>
      viewer ? prefetchOrbitalImagery(viewer, state, info, fov, aspect) : 0,
    routeClick: (handle) =>
      viewer
        ? routeViewerClick(viewer, handle)
        : engine.input.on('click', (event) => handle(event.position)),
    canvasPosition: (world) => engine.projector.worldToWindow(world) ?? null,
    routeDoubleClick: (handle) =>
      viewer
        ? routeViewerDoubleClick(viewer, handle)
        : engine.input.on('doubleClick', (event) => handle(event.position)),
  };
}
