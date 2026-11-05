/**
 * @module render/cesium/sceneRenderer
 * @description The part of the Cesium renderer the reference scenes need,
 * through the contract's own members: a bare globe and sky, icons, points,
 * lines, shapes and models, `setView`, picks and projection, the frame
 * phases, settling and capture. The `/dev/conformance/` page draws the
 * scenes with it to make and check the visual references.
 *
 * Its ports are `ports.js`'s, which the application's renderer shares;
 * this factory adds the conformance widget, its fixed settings and the
 * bare-globe and sky members.
 *
 * It is not yet the whole Cesium renderer: each later migration adds the
 * members its layer family needs, until it passes the whole suite.
 * Members it does not have are absent, never stubbed.
 */
import * as Cesium from 'cesium';
import { createCesiumPorts } from './ports.js';

export { toCartesian, toColor, toImage } from './ports.js';

const SKY_DEFAULTS = Object.freeze({
  atmosphere: false,
  stars: false,
  milkyWay: 0,
  sun: false,
  moon: false,
  fog: false,
  lighting: false,
});

/**
 * @param {{container: HTMLElement, msaa?: number}} options
 * @returns {Promise<object>} A renderer with the members listed above.
 */
export async function createCesiumSceneRenderer({ container, msaa = 4 }) {
  const credits = document.createElement('div');
  const widget = new Cesium.CesiumWidget(container, {
    baseLayer: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    skyBox: false,
    skyAtmosphere: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    msaaSamples: msaa,
    creditContainer: credits,
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
  });
  const scene = widget.scene;
  // A fixed time, so lighting is the same in every capture.
  widget.clock.shouldAnimate = false;
  widget.clock.currentTime = Cesium.JulianDate.fromIso8601(
    '2026-06-21T18:00:00Z',
  );
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#1c2a36');
  scene.backgroundColor = Cesium.Color.BLACK;
  scene.globe.showGroundAtmosphere = false;
  scene.fog.enabled = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;

  const sky = { ...SKY_DEFAULTS };
  const capabilities = new Set(['models']);

  function applySky() {
    scene.globe.enableLighting = sky.lighting;
    scene.fog.enabled = sky.fog;
    if (scene.sun) scene.sun.show = sky.sun;
    if (scene.moon) scene.moon.show = sky.moon;
    scene.globe.showGroundAtmosphere = sky.atmosphere;
    scene.requestRender();
  }

  const ports = createCesiumPorts(widget);
  const frame = {
    ...ports.frame,
    setTime(ms) {
      widget.clock.currentTime = Cesium.JulianDate.fromDate(new Date(ms));
      widget.clock.shouldAnimate = false;
      scene.requestRender();
    },
  };

  // --- Globe -----------------------------------------------------------------

  const globe = {
    async setBase(base) {
      if (
        base.photoreal ||
        (base.terrain && base.terrain.kind !== 'ellipsoid') ||
        base.imagery?.length
      )
        throw new Error('the scene renderer draws a bare globe only');
      return { photoreal: { route: 'none' }, imagery: [], settled: true };
    },
    setGlobeVisible(visible) {
      scene.globe.show = visible;
      scene.requestRender();
    },
    sky: {
      get: () => ({ ...sky }),
      set(settings) {
        Object.assign(sky, settings);
        applySky();
      },
    },
    isSettled: () => scene.globe.tilesLoaded,
  };

  // --- Renderer --------------------------------------------------------------

  async function whenSettled({ timeoutMs = 20000 } = {}) {
    const models = ports.modelSets;
    const end = performance.now() + timeoutMs;
    let quiet = 0;
    while (performance.now() < end) {
      await ports.nextPostRender();
      if (models().some((r) => r.host.failed > 0))
        return { state: 'failed', blockers: ['models'] };
      const loading = models().some((r) => r.host.loading > 0);
      quiet = scene.globe.tilesLoaded && !loading ? quiet + 1 : 0;
      if (quiet >= 3) return { state: 'settled', blockers: [] };
    }
    const blockers = [];
    if (!scene.globe.tilesLoaded) blockers.push('globe');
    if (models().some((r) => r.host.loading > 0)) blockers.push('models');
    return { state: 'timeout', blockers };
  }

  return {
    id: 'cesium',
    contractVersion: '0',
    capabilities,
    canvas: scene.canvas,
    frame,
    globe,
    draw: ports.draw,
    camera: ports.camera,
    query: ports.query,
    capture: ports.capture,
    whenSettled,
    resize: () => widget.resize(),
    destroy() {
      ports.dispose();
      widget.destroy();
    },
  };
}
