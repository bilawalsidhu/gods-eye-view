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
 * the application with the renderer (its `applicationHooks`); the globe
 * port drapes its imagery on that base as drawn (see `globe.js`).
 * `whenSettled` waits for the globe, the scene's 3D tiles and what the draw
 * sets hold.
 *
 * What only this renderer needs at startup is set up here: the free-look
 * height limit, keyboard access to the credits' expand link (in the page's
 * language). The plugin's `applicationHooks` are what the application
 * uses where a renderer has them: the map engine, stale command trimming,
 * whether an entity is the viewer's own, and the viewer QA scripts read.
 * Adapter code reaches the viewer behind a renderer through
 * `cesiumViewerOf` (`viewers.js`), never through a renderer member, so no
 * engine type crosses the contract.
 */
import * as Cesium from 'cesium';
import { createApplicationViewer } from './applicationViewer.js';
import { CONTRACT_VERSION } from '../contract/index.js';
import { bindRenderer } from '../rendererOf.js';
import { FREE_LOOK_MAX_HEIGHT_METERS } from '../../globeInView.js';
import { createCesiumInput } from './input.js';
import { cesiumCapabilities, createCesiumPorts } from './ports.js';
import { IDLE_FRAME_RATE } from '../../renderGovernor.js';
import { cesiumMapEngine } from './mapEngine.js';
import { installFreeLookHeightLimit } from './freeLookLimit.js';
import { trimStaleSceneCommands } from './sceneCommandRelease.js';
import { configureCreditKeyboardAccess } from './creditKeyboard.js';
import { onLocaleChange } from '../../i18n/index.js';
import { cesiumViewerOf, recordViewer } from './viewers.js';
import { installRenderFailureNotice } from './renderFailure.js';

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
 * The Cesium plugin over a viewer factory; tests pass a fake one. With
 * `cameraController` (the shared camera controller's factory), its camera
 * port is that controller's over Cesium's camera, which takes the user's
 * input in place of Cesium's own controls (`controlledCamera.js`).
 * @param {{createViewer?: typeof createApplicationViewer,
 *   cameraController?: Function}} [options]
 */
export function createCesiumRendererPlugin({
  createViewer = createApplicationViewer,
  cameraController,
} = {}) {
  return Object.freeze({
    id: 'cesium',
    /**
     * The credentials are the globe port's, for a base set through it; the
     * scene still loads the application's own base itself. `msaa` makes
     * the viewer (4 when not given);
     * `sky` and `time` are set before the first frame; `clock.now` is what
     * the frame ticks, the camera's `moveEnd` wait, input and flights (the
     * scene's tweens step on it) read, `clock.date` what a `live` motion
     * clock reads. Inertia keeps Cesium's own timing: its camera controls
     * time a release by the system clock.
     * @param {import('../contract/renderer').CreateOptions} options
     * @returns {Promise<TransitionalRenderer>}
     */
    async create({
      container,
      signal,
      googleApiKey,
      googleTokens,
      worldDataToken,
      msaa,
      sky,
      time,
      clock,
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
        viewer = createViewer({
          container,
          creditContainer,
          // The application's notice (`renderFailureNotice`) replaces
          // Cesium's dead-end panel when rendering stops.
          showRenderLoopErrors: false,
          msaa,
        });
        if (Number.isFinite(time))
          viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date(time));
        const now = clock ? () => clock.now() : undefined;
        capabilities = new ReadonlySet(cesiumCapabilities(viewer.scene));
        ports = createCesiumPorts(viewer, {
          capabilities,
          // Ticking at the display's rate only while anything moves.
          idleFps: IDLE_FRAME_RATE,
          credentials: { googleApiKey, googleTokens, worldDataToken },
          ...(cameraController ? { cameraController } : {}),
          ...(clock ? { now, date: () => clock.date() } : {}),
        });
        input = createCesiumInput(viewer, {
          query: ports.query,
          report: ports.report,
          ...(ports.suspendCamera
            ? { suspendCamera: ports.suspendCamera }
            : {}),
          ...(clock ? { now } : {}),
        });
        // Before the first frame, so nothing draws in the wrong sky.
        if (sky) ports.globe.sky.set(sky);
        ports.attachInput?.(input.port);
        // Free look is limited to low heights from the start, on Cesium's
        // own controls (the controller keeps its own limits).
        if (!cameraController)
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
      return renderer;
    },
    /**
     * @param {TransitionalRenderer} renderer
     * @returns {import('../contract/renderer').ApplicationHooks}
     */
    applicationHooks(renderer) {
      const viewer = cesiumViewerOf(renderer);
      return {
        mapEngine: cesiumMapEngine,
        // Cesium's credit display (#cesium-credits) shows the credits.
        ownCreditDisplay: true,
        // Drops the draw commands the scene keeps after it stops drawing
        // them; run after a drawn frame (see sceneCommandRelease.js).
        trimStaleCommands: () => trimStaleSceneCommands(viewer.scene),
        // Whether an entity is one of the viewer's own (Cockpit asks whether
        // the aircraft it flies still draws).
        viewerDrawsEntity: (entity) => viewer.entities.contains(entity),
        // QA scripts drive and read the viewer itself.
        qaHandles: { viewer },
        // A recoverable notice when the globe stops drawing
        // (renderFailure.js).
        renderFailureNotice: (options) =>
          installRenderFailureNotice(viewer, options),
      };
    },
  });
}

/** The default plugin. */
export const cesiumRenderer = createCesiumRendererPlugin();
