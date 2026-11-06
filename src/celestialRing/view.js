// The shared engine view has no renderer-library imports. Reuse its cached
// camera basis for the celestial canvas, with flight and host ownership here.
import { createEngineLayerView } from '../layers/shared/render/engineView.js';
export function createCelestialView(engine) {
  const adapter = createEngineLayerView(engine, { layerId: 'celestial-ring' });
  const { view } = adapter;
  view.container = engine.host.container;
  view.scene.canvas = engine.host.canvas;
  view.scene.postRender = engine.frames.postRender;
  view.scene.requestRender = () => engine.render.request('celestial-ring');
  view.camera.flyTo = ({ easingFunction, ...options }) =>
    engine.camera.flyTo({ ...options, easing: 'cubicInOut' });
  return {
    view,
    destroy() {
      adapter.destroy();
    },
  };
}
