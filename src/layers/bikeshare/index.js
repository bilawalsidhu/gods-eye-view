import { createIngestion } from './ingestion.js';
import { createModel } from './model.js';
import { createViewport } from './viewport.js';
import { createRendering } from './rendering.js';
import { createSelection } from './selection.js';
import { createQueries } from './queries.js';
import { createTesting } from './testing.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createState } from './state.js';

/** Construct one layer with its own scene state and supplied application services. */
export function createBikeshareLayer({ services, source }) {
  if (typeof source?.getStations !== 'function')
    throw new TypeError('A bikeshare source is required');
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source };
  parts.ingestion = createIngestion(context);
  parts.model = createModel(context);
  parts.viewport = createViewport(context);
  parts.rendering = createRendering(context);
  parts.selection = createSelection(context);
  parts.queries = createQueries(context);
  parts.testing = createTesting(context);
  parts.controls = createControls(context);
  parts.lifecycle = createLifecycle(context);
  return Object.assign(
    {},
    parts.controls.methods,
    parts.lifecycle.methods,
    parts.ingestion?.methods,
    {
      createBikeshareSelectedOverlayEntry:
        parts.selection.createBikeshareSelectedOverlayEntry,
      _setBikeshareSelectionStateForTest:
        parts.testing._setBikeshareSelectionStateForTest,
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
