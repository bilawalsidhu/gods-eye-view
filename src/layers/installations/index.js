import { createIngestion } from './ingestion.js';
import { createViewport } from './viewport.js';
import { createControls } from './controls.js';
import { createState } from './state.js';
import { createModel } from './model.js';

/** Construct one layer with its own scene state and supplied application services. */
export function createInstallationsLayer({
  services,
  source,
  overlayHost,
  rendererFactory,
}) {
  if (
    typeof source?.getMappedSites !== 'function' ||
    typeof source?.searchNearby !== 'function'
  )
    throw new TypeError('An installation source is required');
  if (typeof rendererFactory !== 'function')
    throw new TypeError('An installation renderer factory is required');
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source, overlayHost };
  parts.model = createModel(context);
  parts.ingestion = createIngestion(context);
  parts.viewport = createViewport(context);
  parts.controls = createControls(context);
  let renderer = null;
  const lifecycle = {
    init(viewer, options = {}) {
      if (viewer || options.engine) return lifecycle.attachRenderer(options);
    },
    picks: {
      owner: 'military-installations',
      predicate: (id) => state.recordById.has(id),
    },
    attachRenderer(options = {}) {
      if (renderer)
        throw new Error('Installations layer is already initialized');
      const engine = options.engine ?? null;
      renderer = rendererFactory({ ...context, engine });
      if (!renderer) throw new Error('Installation renderer is unavailable');
      parts.display = renderer;
      const ready = renderer.init();
      if (state.enabled) {
        renderer.enable();
        renderer.renderRecords({
          claimSelection: Boolean(state.selectedId),
        });
      }
      return ready;
    },
    enable(...args) {
      state.enabled = true;
      return renderer.enable(...args);
    },
    disable(...args) {
      if (renderer) return renderer.disable(...args);
      state.enabled = false;
      state.abort?.abort();
      state.abort = null;
      state.loading = false;
      state.selectedId = null;
      state.contextAnchor = null;
      state.contextPosition = null;
      state.cameraLoadKey = null;
      state.cameraLoadOwner = null;
      state.coverage = { kind: 'viewport' };
      clearTimeout(state.timer);
      parts.viewport.clearUnavailableRetry();
      services.context.clearSelectedEntityContextForLayer(
        'military-installations',
      );
      parts.ingestion.setInstallationStatus('idle');
    },
    detachRenderer() {
      renderer.detach();
      renderer = null;
      parts.display = null;
    },
    destroy(...args) {
      if (renderer) renderer.destroy(...args);
      else {
        lifecycle.disable();
        source.destroy?.();
      }
      renderer = null;
    },
  };
  return Object.assign(
    {},
    parts.controls.methods,
    lifecycle,
    parts.ingestion?.methods,
    {
      approximateSurfaceDistanceM: parts.model.approximateSurfaceDistanceM,
      classifyGoogleMilitaryPlace: parts.model.classifyGoogleMilitaryPlace,
      installationSourceLabel: parts.model.installationSourceLabel,
      installationSurfaceHeightM: parts.model.installationSurfaceHeightM,
      installationWithinViewport: parts.model.installationWithinViewport,
      installationResponseSaturated: parts.model.installationResponseSaturated,
      installationRetryDelayMs: parts.viewport.installationRetryDelayMs,
    },
  );
}
export { createInstallationSource } from './source.js';
