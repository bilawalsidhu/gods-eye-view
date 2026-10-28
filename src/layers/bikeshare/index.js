import { createIngestion } from './ingestion.js';
import { createModel } from './model.js';
import { createQueries } from './queries.js';
import { createTesting } from './testing.js';
import { createControls } from './controls.js';
import { createState } from './state.js';
import { createBikeshareSelectedOverlayEntry } from './selectionModel.js';

/** Construct one layer with its own scene state and supplied application services. */
export function createBikeshareLayer({ services, source, rendererFactory }) {
  if (typeof source?.getStations !== 'function')
    throw new TypeError('A bikeshare source is required');
  if (typeof rendererFactory !== 'function')
    throw new TypeError('A bikeshare renderer factory is required');
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source };
  parts.ingestion = createIngestion(context);
  parts.model = createModel(context);
  parts.queries = createQueries(context);
  parts.testing = createTesting(context);
  parts.controls = createControls(context);
  let renderer = null;
  let initialized = false;
  const lifecycle = {
    init(viewer, options = {}) {
      if (initialized)
        throw new Error('Bikeshare layer is already initialized');
      renderer ??= rendererFactory({
        ...context,
        viewer,
        engine: options.engine ?? null,
      });
      if (!renderer?.lifecycle?.methods)
        throw new Error('Bikeshare renderer is unavailable');
      Object.assign(parts, renderer);
      initialized = true;
      try {
        return renderer.lifecycle.methods.init(viewer, options);
      } catch (error) {
        initialized = false;
        throw error;
      }
    },
    enable(...args) {
      return renderer?.lifecycle.methods.enable(...args);
    },
    disable(...args) {
      return renderer?.lifecycle.methods.disable(...args);
    },
    destroy(...args) {
      try {
        return renderer?.lifecycle.methods.destroy(...args);
      } finally {
        renderer = null;
        initialized = false;
        for (const key of ['rendering', 'selection', 'viewport', 'lifecycle'])
          delete parts[key];
      }
    },
  };
  return Object.assign(
    {},
    parts.controls.methods,
    lifecycle,
    parts.ingestion?.methods,
    {
      createBikeshareSelectedOverlayEntry,
      _setBikeshareSelectionStateForTest: (options) => {
        renderer ??= rendererFactory({ ...context, viewer: options.viewer });
        Object.assign(parts, renderer);
        parts.testing._setBikeshareSelectionStateForTest(options);
      },
      _selectBikeshareStationForTest:
        parts.testing._selectBikeshareStationForTest,
      _clearBikeshareSelectionForTest:
        parts.testing._clearBikeshareSelectionForTest,
    },
  );
}
export {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
} from './policy.js';

export { createBikeshareSource } from './source.js';
