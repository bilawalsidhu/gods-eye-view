/**
 * @module render/cesium/appRenderer
 * @description The application's default renderer plugin: today's Cesium
 * viewer, set up exactly as before, behind the contract's `RendererPlugin`
 * (`src/render/contract/renderer.d.ts`).
 *
 * The renderer it makes is transitional. Its ports are the shared Cesium
 * ports (`ports.js`), the ones the conformance renderer is checked with,
 * less the members that would not be true of the application yet: the
 * globe (it draws photoreal tiles the port does not know), `whenSettled`
 * (it would not wait for them), `frame.setTime` (it would stop the
 * application's clock). Those arrive with the layer families that need
 * them (phase 2 of the renderer plan); `checkRendererShape` lists what is
 * still missing.
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

/**
 * The members a transitional renderer has today.
 * @typedef {Pick<import('../contract/renderer').Renderer,
 *   'id' | 'contractVersion' | 'capabilities' | 'canvas' | 'frame' | 'draw'
 *   | 'camera' | 'query' | 'input' | 'effects' | 'capture' | 'credits'
 *   | 'on' | 'resize' | 'destroy'>}
 *   TransitionalRenderer
 */

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
     * Credentials stay with the scene, which still loads the tiles; they
     * move into the renderer with the globe port.
     * @param {{container: HTMLElement, signal: AbortSignal}} options
     * @returns {Promise<TransitionalRenderer>}
     */
    async create({ container, signal }) {
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
        ports = createCesiumPorts(viewer, { capabilities });
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
        draw: ports.draw,
        camera: ports.camera,
        query: ports.query,
        input: input.port,
        effects: ports.effects,
        capture: ports.capture,
        credits: ports.credits,
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
