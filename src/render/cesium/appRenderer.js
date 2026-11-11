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
 * through the Cesium map engine (`mapEngine.js`), which the plugin hands
 * the application with the renderer (`../applicationHooks.js`); the globe
 * port drapes its imagery on that base as drawn (see `globe.js`).
 * `whenSettled` waits for the globe, the scene's 3D tiles and what the draw
 * sets hold.
 *
 * What only this renderer needs at startup is set up here: the free-look
 * height limit, keyboard access to the credits' expand link (in the page's
 * language), and the hooks the application uses where a renderer has
 * them (stale command trimming, inline panel rendering, whether an entity
 * is the viewer's own, the zoom-out guard, the viewer QA scripts read).
 * Adapter code reaches the viewer behind a renderer through
 * `cesiumViewerOf` (`viewers.js`), never through a renderer member, so no
 * engine type crosses the contract.
 */
import { createApplicationViewer } from './applicationViewer.js';
import { CONTRACT_VERSION } from '../contract/index.js';
import { bindRenderer } from '../rendererOf.js';
import { provideApplicationHooks } from '../applicationHooks.js';
import { FREE_LOOK_MAX_HEIGHT_METERS } from '../../globeInView.js';
import { createCesiumInput } from './input.js';
import { cesiumCapabilities, createCesiumPorts } from './ports.js';
import { cesiumMapEngine } from './mapEngine.js';
import { installFreeLookHeightLimit } from './freeLookLimit.js';
import { keepPanelRendering } from './panelRendering.js';
import { trimStaleSceneCommands } from './sceneCommandRelease.js';
import { installZoomOutGuard } from './zoomOutGuard.js';
import { createViewerOcclusionProbe } from './sceneOcclusionProbe.js';
import { configureCreditKeyboardAccess } from './creditKeyboard.js';
import { onLocaleChange } from '../../i18n/index.js';
import { cesiumViewerOf, recordViewer } from './viewers.js';

export { cesiumViewerOf };

/** @typedef {import('../contract/renderer').Renderer} TransitionalRenderer */

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
      let releaseFreeLook = () => {};
      let offLocale = () => {};
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
        // Free look is limited to low heights from the start.
        releaseFreeLook = installFreeLookHeightLimit(
          viewer,
          FREE_LOOK_MAX_HEIGHT_METERS,
        );
        configureCreditKeyboardAccess(document);
        offLocale = onLocaleChange(() =>
          configureCreditKeyboardAccess(document),
        );
      } catch (error) {
        offLocale();
        releaseFreeLook();
        input?.dispose();
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
            offLocale();
            releaseFreeLook();
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
      recordViewer(renderer, viewer);
      unbind = bindRenderer(viewer, renderer);
      provideApplicationHooks(renderer, {
        mapEngine: cesiumMapEngine,
        // Cesium's credit display (#cesium-credits) shows the credits.
        ownCreditDisplay: true,
        // Drops the draw commands the scene keeps after it stops drawing
        // them; run after a drawn frame (see sceneCommandRelease.js).
        trimStaleCommands: () => trimStaleSceneCommands(viewer.scene),
        // Keeps the globe drawing in an inline panel whose host stops
        // animation frames (embed mode, src/app/embed.js).
        keepPanelRendering: (options) => keepPanelRendering(viewer, options),
        // Whether an entity is one of the viewer's own (Cockpit asks whether
        // the aircraft it flies still draws).
        viewerDrawsEntity: (entity) => viewer.entities.contains(entity),
        // Keeps outward user zooms bounded and the Earth framed; returns its
        // disposer (see zoomOutGuard.js).
        installZoomOutGuard: (options) => installZoomOutGuard(viewer, options),
        // Tests depth-tested contacts (street vehicles) against the frame's
        // own depth, for the detection overlay (see sceneOcclusionProbe.js).
        createOcclusionProbe: () => createViewerOcclusionProbe(viewer),
        // QA scripts drive and read the viewer itself.
        qaHandles: { viewer },
      });
      return renderer;
    },
  });
}

/** The default plugin. */
export const cesiumRenderer = createCesiumRendererPlugin();
