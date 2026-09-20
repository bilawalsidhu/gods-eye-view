import { createModel } from './model.js';
import { createIngestion } from './ingestion.js';
import { createRendering } from './rendering.js';
import { createCards } from './cards.js';
import { createSelection } from './selection.js';
import { createViewport } from './viewport.js';
import { createLifecycle } from './lifecycle.js';
import { createQueries } from './queries.js';
import { createFirmsState } from './state.js';

export function createFirmsHelpers({ services }) {
  const layerState = createFirmsState({ services, config: {} });
  return createModel({ layerState, services, config: {}, components: {} });
}

/** Compose one fire layer with explicit source and scene operations. */
export function createFirmsHeatmapLayer({ services, feed, ...config }) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Fires require a snapshot source');
  const layerState = createFirmsState({ services, config });
  const components = {};
  const context = { layerState, services, config, components, feed };
  components.model = createModel(context);
  components.ingestion = createIngestion(context);
  components.rendering = createRendering(context);
  components.cards = createCards(context);
  components.selection = createSelection(context);
  components.viewport = createViewport(context);
  components.lifecycle = createLifecycle(context);
  components.queries = createQueries(context);
  return Object.assign(
    {},
    components.queries.methods,
    components.lifecycle.methods,
    components.ingestion.methods,
  );
}

export { createFirmsSource } from './source.js';
export { createFireAnchors, FIRE_ANCHOR_LIFT_M } from './anchors.js';
export * from '../../data/firmsAdapt.js';
export * from '../../data/firmsLabels.js';
