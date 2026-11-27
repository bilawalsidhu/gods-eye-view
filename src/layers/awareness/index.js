import { createModel } from './model.js';
import { createSubject } from './subject.js';
import { createPanel } from './panel.js';
import { createQueries } from './queries.js';
import { createNavigation } from './navigation.js';
import { createFocus } from './focus.js';
import { createTesting } from './testing.js';
import { createHistory } from './history.js';
import { createRendering } from './rendering.js';
import { createLifecycle } from './lifecycle.js';
import { createDependencies } from './dependencies.js';
import { createControls } from './controls.js';
import { createState } from './state.js';

/**
 * Construct one layer with its own scene state and supplied application services.
 *
 * Its context rim is a renderer draw set (`drawOf(viewer)`) and its flights
 * go through `cameraOf`. Given a Cesium viewer with no
 * renderer bound, the caller loads the package's `./render/cesium/unbound`
 * export first.
 */
export function createAwarenessLayer({ services }) {
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts };
  parts.model = createModel(context);
  parts.subject = createSubject(context);
  parts.panel = createPanel(context);
  parts.queries = createQueries(context);
  parts.navigation = createNavigation(context);
  parts.focus = createFocus(context);
  parts.testing = createTesting(context);
  parts.history = createHistory(context);
  parts.rendering = createRendering(context);
  parts.lifecycle = createLifecycle(context);
  parts.dependencies = createDependencies(context);
  parts.controls = createControls(context);
  const layer = Object.assign(
    {},
    parts.controls.methods,
    parts.lifecycle.methods,
    {
      subscribePanel: parts.panel.subscribePanel,
      subscribeDirectionOverlay: parts.rendering.subscribeDirectionOverlay,
      contactsWindowFromSnapshot: parts.model.contactsWindowFromSnapshot,
    },
  );
  Object.defineProperty(layer, 'testing', { value: parts.testing });
  return layer;
}
export { AWARENESS_QUERY_LIMIT } from './policy.js';
