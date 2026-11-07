/**
 * @module render/cesium/appRenderer
 * @description The application's default renderer plugin: today's Cesium
 * viewer, set up exactly as before, behind the contract's `RendererPlugin`
 * (`src/render/contract/renderer.d.ts`).
 *
 * The renderer it makes is transitional. Its ports are the shared Cesium
 * ports (`ports.js`), the ones the conformance renderer is checked with,
 * and it has every member of the contract. The application's base (the
 * photoreal tiles, the map stack's imagery and terrain) is still loaded
 * through the viewer by the scene and the map stack; the globe port drapes
 * its imagery on that base as drawn (see `globe.js`). `whenSettled` waits
 * for the globe, the scene's 3D tiles and what the draw sets hold, not for
 * what layers still draw through the viewer themselves.
 * Until a family is ported, its code reaches the Cesium viewer through
 * `cesiumViewerOf`, never through a renderer member, so no engine type
 * crosses the contract and each call marks code still to port. Ported code
 * that still holds the viewer reaches the renderer through `rendererOf`.
 */
import { createApplicationViewer } from '../../app/viewer.js';
import { CONTRACT_VERSION } from '../contract/index.js';
import { bindRenderer } from '../rendererOf.js';
import { createCesiumInput } from './input.js';
import { cesiumCapabilities, createCesiumPorts } from './ports.js';

/** @typedef {import('../contract/renderer').Renderer} TransitionalRenderer */

const viewers = new WeakMap();

/** A Set no one can change once built, so `capabilities` stays true. */
export class ReadonlySet extends Set {
  #sealed;
  constructor(values = []) {
    // Filled here, not by Set's constructor: it would call the guarded add
    // before the private field exists.
    super();
    for (const value of values) super.add(value);
    this.#sealed = true;
  }
  add(value) {
    if (this.#sealed) throw new TypeError('capabilities are read-only');
    return super.add(value);
  }
  delete() {
    throw new TypeError('capabilities are read-only');
  }
  clear() {
    throw new TypeError('capabilities are read-only');
  }
}

/**
 * The Cesium viewer behind a renderer this plugin made, or null for any
 * other renderer.
 * @param {object} renderer
 * @returns {object|null}
 */
export const cesiumViewerOf = (renderer) => viewers.get(renderer) ?? null;

/**
 * The Cesium plugin over a viewer factory; tests pass a fake one.
 * @param {{createViewer?: typeof createApplicationViewer}} [options]
 */
export function createCesiumRendererPlugin({
  createViewer = createApplicationViewer,
} = {}) {
  return Object.freeze({
    id: 'cesium',
    /**
     * The credentials are the globe port's, for a base set through it; the
     * scene still loads the application's own base itself.
     * @param {import('../contract/renderer').CreateOptions} options
     * @returns {Promise<TransitionalRenderer>}
     */
    async create({
      container,
      signal,
      googleApiKey,
      googleTokens,
      worldDataToken,
    }) {
      signal?.throwIfAborted();
      // Provider attribution stays visible, including clean-view and recording.
      const creditContainer = document.createElement('div');
      creditContainer.id = 'cesium-credits';
      document.body.appendChild(creditContainer);
      let viewer;
      let ports;
      let input;
      let capabilities;
      try {
        viewer = createViewer({ container, creditContainer });
        capabilities = new ReadonlySet(cesiumCapabilities(viewer.scene));
        ports = createCesiumPorts(viewer, {
          capabilities,
          credentials: { googleApiKey, googleTokens, worldDataToken },
        });
        input = createCesiumInput(viewer, {
          query: ports.query,
          report: ports.report,
        });
      } catch (error) {
        ports?.dispose();
        if (viewer && !viewer.isDestroyed()) viewer.destroy();
        creditContainer.remove();
        throw error;
      }
      let unbind = () => {};
      const renderer = Object.freeze({
        id: 'cesium',
        contractVersion: CONTRACT_VERSION,
        capabilities,
        canvas: viewer.canvas,
        frame: ports.frame,
        globe: ports.globe,
        draw: ports.draw,
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
        on: ports.on,
        resize() {
          viewer.resize();
        },
        destroy() {
          try {
            input.dispose();
            ports.dispose();
            if (!viewer.isDestroyed()) viewer.destroy();
          } finally {
            // Bound until the viewer is gone: a late `cameraOf` must not
            // build a camera of its own over the application's viewer.
            unbind();
            creditContainer.remove();
          }
        },
      });
      viewers.set(renderer, viewer);
      unbind = bindRenderer(viewer, renderer);
      return renderer;
    },
  });
}

/** The default plugin. */
export const cesiumRenderer = createCesiumRendererPlugin();
