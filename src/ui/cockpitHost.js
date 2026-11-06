// Camera and aircraft ownership used by the shared first-person controller,
// on the globe contract: the ridden aircraft is the engine follow's target,
// the aircraft display's tracked glyph handle.
import { routeViewerDoubleClick } from '../globe/cesium/doubleClick.js';

/**
 * @param {import('../globe/contract.js').GlobeEngine} engine
 * @param {{ viewer?: object|null }} [options] `viewer`: Cesium's Viewer when
 *   the engine is Cesium. Its stock double-click would drop the follow, so
 *   the Cockpit's goes first; Navara has none to route around.
 */
export function cockpitHost(engine, { viewer = null } = {}) {
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
    cartographic: () => engine.camera.pose().cartographic,
    terrainHeight: (place) => engine.surface.terrainHeight(place),
    surface: engine,
    inputs: (enabled) => engine.input.setCameraInputs(enabled),
    canvasPosition: (world) => engine.projector.worldToWindow(world) ?? null,
    routeDoubleClick: (handle) =>
      viewer
        ? routeViewerDoubleClick(viewer, handle)
        : engine.input.on('doubleClick', (event) => handle(event.position)),
  };
}
