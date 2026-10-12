/**
 * The Gods Eye application, embeddable in a host page.
 *
 * The host owns the page and one root element; this module owns everything
 * inside that element while the application runs. It is the standalone
 * composition (`composeApplication`) with host-supplied configuration instead
 * of Vite's `import.meta.env`, the application chrome inserted into `root`,
 * runtime-created floating DOM kept under `root`, asset URLs from the host,
 * and the world-model layer built from the host's ProjectionSource.
 *
 * The world model is the only data source (DWM-136). There is no provider
 * API: every layer with a registered world adapter (`WORLD_LAYER_SOURCE_KEYS`)
 * reads the host's `worldModelSource`; every other source-backed layer has no
 * source, stays registered, and is left out of the panel
 * (`SOURCELESS_LAYER_IDS`). Each drawable product no adapter claims is a
 * layer of its own, discovered from the backplane at start, under a World
 * Model block that is the configuration rather than a toggle; the embed has
 * one fixed look (`presentation.js`) (DWM-189). A host cannot choose otherwise -- the removed
 * `apiBaseUrl` and `layerSources` options are refused, not ignored, so a host
 * still passing them fails at once instead of silently losing its layers.
 *
 * Styles: load the package's `src/embedded/embedded.css` as a stylesheet
 * (generated from style.css, every rule scoped under `.gods-eye-root`, which
 * this module adds to `root`). The host sizes and positions `root`; static
 * assets come from the package's `public/` directory served at `assetBaseUrl`.
 *
 * Lifecycle: the returned handle is the `createApplication` handle
 * (start/destroy/subscribe/getState/getComponents). One application runs per
 * page at a time; after `destroy()` resolves, a new one may start. Destroy
 * removes the chrome and the font stylesheets it added to <head>, and restores
 * <body> classes, endpoint, layer source and host settings.
 *
 * Nothing here imports server, build or provider modules.
 */
import { composeApplication } from '../standalone/application.js';
import { createStandaloneWorldModelLayer } from '../data/worldModel.js';
import { configureEndpoints } from '../sources/endpoints.js';
import { configureLayerSources } from '../sources/layerSources.js';
import {
  EMBEDDED_HIDDEN_LAYER_IDS,
  EMBEDDED_LAYER_SOURCES,
  EMBEDDED_PANEL_LABELS,
  refuseRemovedOptions,
} from './options.js';
import { discoverWithin, productLayerOptions } from './worldProducts.js';
import { mountWorldConfig } from './worldConfig.js';
import { openRun } from './worldRuns.js';
import { configureHostElement } from '../app/host.js';
import { applyPresentation } from './presentation.js';
import {
  attachApplicationStylesheets,
  renderApplicationMarkup,
  ROOT_CLASS,
} from './chrome.js';

export {
  APPLICATION_MARKUP,
  APPLICATION_STYLESHEETS,
  renderApplicationMarkup,
  ROOT_CLASS,
} from './chrome.js';
export { WORLD_MODEL_LAYER_ID } from '../layers/worldModel/index.js';
export { pageOwner } from '../standalone/ownership.js';
export { LAYER_SOURCE_KEYS } from '../sources/layerSources.js';

export {
  EMBEDDED_LAYER_SOURCES,
  SOURCELESS_LAYER_IDS,
  WORLD_LAYER_SOURCE_KEYS,
} from './options.js';

/**
 * Embedded defaults: no page-owning provider dialogs or voice dock, no share
 * link in the host's address, and no scope vignette (DWM-189).
 */
export const EMBEDDED_FEATURES = Object.freeze({
  voice: false,
  keySetup: false,
  firstRun: false,
  shareLink: false,
  scopeMask: false,
});

/**
 * @param {object} options
 * @param {HTMLElement} options.root Host element, attached to the document.
 * @param {object} options.worldModelSource ProjectionSource for the world-model layer.
 * @param {string|null} [options.googleApiKey] Google Map Tiles key (browser-restricted).
 * @param {string|null} [options.cesiumToken] Cesium ion token.
 * @param {string} [options.assetBaseUrl] Prefix for the package's `public/` assets.
 * @param {object} [options.worldModel] Extra world-model layer options (head, predicates, modalities, displayAssumptions, policyThresholdSeconds, updateInterval, debounceMs).
 * @param {object|null} [options.initialCamera] `{lon, lat, heightM?, rangeM, headingDeg, pitchDeg}`.
 * @param {object} [options.features] Opt in to `voice`, `keySetup`, `firstRun`.
 */
export function createEmbeddedApplication(options = {}) {
  refuseRemovedOptions(options);
  const {
    root,
    worldModelSource,
    googleApiKey = null,
    cesiumToken = null,
    assetBaseUrl,
    worldModel = {},
    initialCamera = null,
    features = {},
  } = options;
  if (!root || typeof root.appendChild !== 'function')
    throw new TypeError('An embedding root element is required');
  if (!worldModelSource)
    throw new TypeError('A world-model ProjectionSource is required');
  let queryRoot = null;
  let discovery = { count: 0, error: null };
  let worldConfig = null;
  const app = composeApplication({
    googleApiKey: googleApiKey || undefined,
    cesiumToken: cesiumToken || undefined,
    features: { ...EMBEDDED_FEATURES, ...features },
    initialCamera,
    ownerLabel: 'embedded',
    hiddenLayerIds: EMBEDDED_HIDDEN_LAYER_IDS,
    panelLabels: EMBEDDED_PANEL_LABELS,
    loadingScreen: () => queryRoot.querySelector('#loading-screen'),
    createWorldModelLayer: () =>
      createStandaloneWorldModelLayer({
        ...worldModel,
        source: worldModelSource,
      }),
    // Each unclaimed drawable product of the world is a layer (DWM-189).
    async createProductLayers() {
      const { products, error } = await discoverWithin(worldModelSource, {
        head: worldModel.head,
      });
      discovery = { count: products.length, error };
      void worldConfig?.refresh();
      return products.map((product) =>
        createStandaloneWorldModelLayer({
          ...worldModel,
          ...productLayerOptions(product),
          source: worldModelSource,
        }),
      );
    },
    beforeScene({ defer }) {
      if (!root.isConnected)
        throw new Error('The embedding root must be attached to the document');
      const bodyClasses = document.body.className;
      defer(() => {
        document.body.className = bodyClasses;
      });
      defer(configureEndpoints({ apiBaseUrl: null, assetBaseUrl }));
      defer(
        configureLayerSources({
          layerSources: EMBEDDED_LAYER_SOURCES,
          projectionSource: worldModelSource,
          head: worldModel.head,
        }),
      );
      defer(configureHostElement(root));
      defer(attachApplicationStylesheets(document));
      root.classList.add(ROOT_CLASS);
      root.innerHTML = renderApplicationMarkup(assetBaseUrl);
      applyPresentation(root, ROOT_CLASS);
      worldConfig = mountWorldConfig({
        before: root.querySelector('#data-toggles'),
        source: worldModelSource,
        head: worldModel.head,
        discovery: () => discovery,
      });
      defer(() => {
        worldConfig.remove();
        worldConfig = null;
      });
      queryRoot = root;
      defer(() => {
        root.replaceChildren();
        root.classList.remove(ROOT_CLASS);
        queryRoot = null;
      });
    },
  });
  return Object.freeze({
    ...app,
    /**
     * Open one simulation run (DWM-196): every panel row the run has a
     * product for is pointed at its head and time and switched on, pinned to
     * the receipt's revision when one is given (GEN-299). Resolves to what
     * opened and what has nothing to draw, or rejects with a RunOpenError
     * the host can show (see `worldRuns.js`).
     * @param {string} head A `sim/` head.
     * @param {{validAt?: string|null, revisionId?: string|null,
     *   compare?: {head: string, revisionId?: string|null}|null}} [options]
     */
    openRun: (
      head,
      { validAt = null, revisionId = null, compare = null } = {},
    ) =>
      openRun({
        manager: app.getComponents().data?.dataManager,
        source: worldModelSource,
        head,
        validAt,
        revisionId,
        compare,
      }),
  });
}
