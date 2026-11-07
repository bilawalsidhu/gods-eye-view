/**
 * @module render/cesium/sceneRenderer
 * @description The part of the Cesium renderer the reference scenes need,
 * through the contract's own members: a bare globe and sky, icons, points,
 * lines, shapes and models, `setView`, picks and projection, the frame
 * phases, pointer input, credits, effects, settling, capture, pixel reads
 * and cache release. The
 * `/dev/conformance/` page draws the scenes with it to make and check the
 * visual references.
 *
 * Its ports are `ports.js`'s, which the application's renderer shares;
 * this factory adds the conformance widget, its fixed settings, the input
 * port (`input.js`, not yet the application's) and the bare-globe and sky
 * members.
 *
 * It is not yet the whole Cesium renderer: each later migration adds the
 * members its layer family needs, until it passes the whole suite.
 * Members it does not have are absent, never stubbed.
 */
import * as Cesium from 'cesium';
import { createCesiumInput } from './input.js';
import { cesiumCapabilities, createCesiumPorts } from './ports.js';

export { toCartesian, toColor, toImage } from './ports.js';

/** Each renderer's pointer feed, for the conformance harness. */
const feeds = new WeakMap();

/**
 * Delivers one pointer event to a renderer this made, as its handler would.
 * @param {object} renderer
 * @returns {((type: string, x: number, y: number, extra?: object) => void) | null}
 */
export const pointerFeedOf = (renderer) => feeds.get(renderer) ?? null;

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
 * @param {{container: HTMLElement, msaa?: number, capabilities?: Iterable<string>}} options
 *   `capabilities` limits the renderer to those it lists.
 * @returns {Promise<object>} A renderer with the members listed above.
 */
export async function createCesiumSceneRenderer({
  container,
  msaa = 4,
  capabilities: only,
}) {
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
  // A fixed time, so lighting is the same in every capture; `setTime`
  // moves it and it stays there.
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
  const capabilities = new Set(cesiumCapabilities(scene, only));

  function applySky() {
    scene.globe.enableLighting = sky.lighting;
    scene.fog.enabled = sky.fog;
    if (scene.sun) scene.sun.show = sky.sun;
    if (scene.moon) scene.moon.show = sky.moon;
    scene.globe.showGroundAtmosphere = sky.atmosphere;
    scene.requestRender();
  }

  const ports = createCesiumPorts(widget, { capabilities });
  const input = createCesiumInput(widget, {
    query: ports.query,
    report: ports.report,
  });

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

  const renderer = {
    id: 'cesium',
    contractVersion: '0',
    capabilities,
    canvas: scene.canvas,
    frame: ports.frame,
    globe,
    // A member of a capability left out is absent, not stubbed.
    draw: capabilities.has('models')
      ? ports.draw
      : Object.fromEntries(
          Object.entries(ports.draw).filter(([kind]) => kind !== 'models'),
        ),
    camera: ports.camera,
    query: ports.query,
    input: input.port,
    effects: ports.effects,
    quality: ports.quality,
    capture: ports.capture,
    readPixels: ports.readPixels,
    releaseUnused: ports.releaseUnused,
    credits: ports.credits,
    whenSettled: ports.whenSettled,
    resize: () => widget.resize(),
    on: ports.on,
    destroy() {
      input.dispose();
      ports.dispose();
      widget.destroy();
    },
  };
  feeds.set(renderer, input.feed);
  return renderer;
}
