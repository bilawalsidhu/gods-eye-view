import { rgbaFromCss } from '../../shared/color.js';
// The Global Context visual on the globe contract (engine.lines,
// engine.camera, engine.frames, engine.host), the same on every engine:
// the layer's view of the globe (its canvas, camera, frames, the followed
// contact and a contact flight) and the 250 km range ring, a core line over
// a wider dark halo at the rim height, with straight chords between
// positions that already follow the surface. The pulses inside the ring sit
// through engine.ground. Nothing here takes picks.
//
// Cesium's ring was one polyline in its outline material: a 4 px line whose
// inner 3 px are the core and whose outer pixel is the halo, half on each
// side. Lines have one colour, so here the halo is a 4 px line and the core
// a 3 px line drawn over it.

import * as geo from '../../../geo/index.js';
import { AWARENESS_RADIUS_M } from '../../../data/militaryAwarenessEngine.js';
import { CYBER_SONAR_RENDER_INTERVAL_MS } from '../../../cyberSonar.js';
import { createEngineLayerView } from '../../shared/render/engineView.js';
import {
  AWARENESS_RANGE_PULSE,
  AWARENESS_RANGE_RING_STYLE,
  CONTEXT_RIM_HEIGHT_M,
} from '../policy.js';
import { awarenessRangeRingPositions } from '../rendering.js';

export const RING_ID = 'gev-awareness-rim';
export const RING_HALO_ID = 'gev-awareness-rim-halo';

const RING_CORE = rgbaFromCss(AWARENESS_RANGE_RING_STYLE.color).rgba();
const RING_HALO = rgbaFromCss(AWARENESS_RANGE_RING_STYLE.outlineColor).rgba();
const withAlpha = (rgba, alpha) => [rgba[0], rgba[1], rgba[2], rgba[3] * alpha];

/**
 * The layer's view of `engine`.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 */
export function createAwarenessDisplay(engine) {
  const binding = createEngineLayerView(engine, {
    layerId: 'military-awareness',
  });
  const style = AWARENESS_RANGE_RING_STYLE;
  return {
    engine,
    container: engine.host.container,
    canvas: engine.host.canvas,
    // Camera-shaped: positionWC, heading, rightWC, upWC, refreshed per frame.
    camera: binding.view.camera,
    get trackedEntity() {
      return engine.camera.following()?.native;
    },
    cameraHeight: () => engine.camera.height(),
    // Off while another owner holds the camera (the cockpit, a gizmo drag).
    cameraInputsEnabled: () => engine.input.cameraInputsEnabled(),
    onFrame: (run) => engine.frames.preRender.addEventListener(run),
    onFrameEnd: (run) => engine.frames.postRender.addEventListener(run),
    frameContact: (center, radius, duration) =>
      engine.camera.flyToSphere({ center, radius }, { duration }),

    /**
     * The ring around `center` (on the ellipsoid); `setAlpha` flashes it.
     * Every colour change asks the engine for a frame, so while it fades a
     * flash changes at most once per Cyber sonar interval, the pulses' own
     * cadence; full strength is set at once.
     */
    createRim(center) {
      const halo = engine.lines.createLine({
        id: RING_HALO_ID,
        color: RING_HALO,
        widthPx: style.width,
        order: 0,
      });
      const core = engine.lines.createLine({
        id: RING_ID,
        color: RING_CORE,
        widthPx: Math.max(1, style.width - style.outlineWidth),
        order: 1,
      });
      let alpha = 1;
      let changedAt = Number.NEGATIVE_INFINITY;
      const move = (position) => {
        const positions = awarenessRangeRingPositions(
          position,
          AWARENESS_RADIUS_M,
          CONTEXT_RIM_HEIGHT_M,
        );
        halo.setPositions(positions);
        core.setPositions(positions);
      };
      move(center);
      return {
        move,
        setAlpha(next) {
          if (next === alpha) return;
          const now = performance.now();
          if (next !== 1 && now - changedAt < CYBER_SONAR_RENDER_INTERVAL_MS)
            return;
          alpha = next;
          changedAt = now;
          halo.setColor(withAlpha(RING_HALO, alpha));
          core.setColor(withAlpha(RING_CORE, alpha));
        },
        destroy() {
          core.destroy();
          halo.destroy();
        },
      };
    },

    /** The pulse field around `center`. */
    createPulses: (center) =>
      engine.ground.createPulseField({
        id: 'gev-awareness-pulses',
        heightM: CONTEXT_RIM_HEIGHT_M,
        center: geo.cartesian3.clone(center),
        radiusM: AWARENESS_RADIUS_M,
        // The band's own opacity, as the pulse material sets it.
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
    destroy: binding.destroy,
  };
}
