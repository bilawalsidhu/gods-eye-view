import * as geo from '../../../geo/index.js';
import { createEngineLayerView } from '../../shared/render/engineView.js';
import { AWARENESS_RADIUS_M } from '../../../data/militaryAwarenessEngine.js';
import {
  AWARENESS_RANGE_PULSE,
  AWARENESS_RANGE_RING_STYLE,
  CONTEXT_RIM_HEIGHT_M,
} from '../policy.js';
import { createAwarenessPulseDisc } from './navaraPulses.js';

/** `rgba(r, g, b, a)` as an rgba array in 0..1. */
function rgbaArray(css) {
  const [r, g, b, a = 1] = css.match(/[\d.]+/g).map(Number);
  return [r / 255, g / 255, b / 255, a];
}
const RING_CORE = rgbaArray(AWARENESS_RANGE_RING_STYLE.color);
const RING_HALO = rgbaArray(AWARENESS_RANGE_RING_STYLE.outlineColor);
const withAlpha = (rgba, alpha) => [rgba[0], rgba[1], rgba[2], rgba[3] * alpha];

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

/**
 * The awareness layer's view of a Navara globe. With the globe's native view
 * (`native`: view, EffectDesc and NavaraEffect) it also draws the range
 * pulses; without one, the range ring alone.
 */
export function createAwarenessNavaraRenderer(engine, native = null) {
  const binding = createEngineLayerView(engine, {
    layerId: 'military-awareness',
  });
  const style = AWARENESS_RANGE_RING_STYLE;
  return {
    container: engine.host.container,
    canvas: engine.host.canvas,
    camera: binding.view.camera,
    get trackedEntity() {
      return engine.camera.following()?.native;
    },
    cameraHeight: () => engine.camera.height(),
    onFrame: (run) => binding.view.on('preRender', run),
    onFrameEnd: (run) => engine.frames.postRender.addEventListener(run),
    frameContact: (center, radius, duration) =>
      engine.camera.flyToSphere({ center, radius }, { duration }),
    /**
     * The 250 km ring: a core line over a wider dark halo, as the Cesium
     * ring's outline material draws it; `setAlpha` flashes it.
     */
    createRim(center) {
      const halo = engine.lines.createLine({
        id: 'gev-awareness-rim-halo',
        color: RING_HALO,
        widthPx: style.width,
        arc: 'geodesic',
      });
      const core = engine.lines.createLine({
        id: 'gev-awareness-rim',
        color: RING_CORE,
        widthPx: Math.max(1, style.width - 2 * style.outlineWidth),
        arc: 'geodesic',
      });
      let alpha = 1;
      const move = (position) => {
        const positions = rimPositions(position);
        halo.setPositions(positions);
        core.setPositions(positions);
      };
      move(center);
      return {
        move,
        setAlpha(next) {
          if (next === alpha) return;
          alpha = next;
          halo.setColor(withAlpha(RING_HALO, alpha));
          core.setColor(withAlpha(RING_CORE, alpha));
        },
        destroy() {
          core.destroy();
          halo.destroy();
        },
      };
    },
    // The pulse disc, when the native view can draw it.
    ...(native?.view && native.EffectDesc && native.NavaraEffect
      ? {
          createPulses: (center) =>
            createAwarenessPulseDisc(engine, native, {
              center,
              radiusM: AWARENESS_RADIUS_M,
              // The band's own opacity, as the Cesium material sets it.
              color: [
                ...RING_CORE.slice(0, 3),
                AWARENESS_RANGE_PULSE.gradientOpacity,
              ],
              lineColor: RING_CORE,
              haloColor: RING_HALO,
              depth: AWARENESS_RANGE_PULSE.gradientDepthFraction,
              lineWidth: AWARENESS_RANGE_PULSE.width,
              haloWidth: AWARENESS_RANGE_PULSE.outlineWidth,
            }),
        }
      : {}),
    destroy: binding.destroy,
  };
}
