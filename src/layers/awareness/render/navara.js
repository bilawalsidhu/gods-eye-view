import * as geo from '../../../geo/index.js';
import { createEngineLayerView } from '../../shared/render/engineView.js';
import { AWARENESS_RADIUS_M } from '../../../data/militaryAwarenessEngine.js';
import { CONTEXT_RIM_HEIGHT_M } from '../policy.js';

// Sample in the subject's east/north plane, then lift each vertex onto
// the ellipsoid. This also works when a ring crosses the date line or a pole.
function rimPositions(center) {
  const frame = geo.transforms.eastNorthUpToFixedFrame(center);
  const positions = [];
  for (let i = 0; i < 180; i++) {
    const angle = (i * Math.PI) / 90;
    const local = geo.cartesian3.create(
      Math.cos(angle) * AWARENESS_RADIUS_M,
      Math.sin(angle) * AWARENESS_RADIUS_M,
      0,
    );
    const world = geo.matrix4.multiplyByPoint(
      frame,
      local,
      geo.cartesian3.create(),
    );
    const point = geo.cartographic.fromCartesian(world);
    positions.push(
      geo.cartesian3.fromRadians(
        point.longitude,
        point.latitude,
        CONTEXT_RIM_HEIGHT_M,
      ),
    );
  }
  positions.push(positions[0]);
  return positions;
}

export function createAwarenessNavaraRenderer(engine) {
  const binding = createEngineLayerView(engine, {
    layerId: 'military-awareness',
  });
  return {
    container: engine.host.container,
    canvas: engine.host.canvas,
    camera: binding.view.camera,
    get trackedEntity() {
      return engine.camera.following()?.native;
    },
    onFrame: (run) => binding.view.on('preRender', run),
    frameContact: (center, radius, duration) =>
      engine.camera.flyToSphere({ center, radius }, { duration }),
    createRim(center) {
      const line = engine.lines.createLine({
        id: 'gev-awareness-rim',
        color: [98 / 255, 181 / 255, 1, 0.72],
        widthPx: 1,
        arc: 'geodesic',
      });
      const move = (position) => line.setPositions(rimPositions(position));
      move(center);
      return { move, destroy: () => line.destroy() };
    },
    destroy: binding.destroy,
  };
}
