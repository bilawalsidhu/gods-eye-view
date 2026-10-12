import { createState } from './state.js';
import { createRendering } from './rendering.js';
import { createPresenter } from './presenter.js';
import { createPlayback } from './playback.js';
import { createSelection } from './selection.js';
import { createIngestion } from './ingestion.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';

const SOURCE_METHODS = [
  'getRegions',
  'getForecast',
  'getObservations',
  'getSeason',
];

/**
 * Construct the avalanche layer: Varsom danger forecasts and regObs observed
 * avalanches played over a ten-day window, with off-season replay.
 * @param {{source:object, services:object}} options Frame source and application services.
 */
export function createAvalancheLayer({ services, source }) {
  for (const method of SOURCE_METHODS)
    if (typeof source?.[method] !== 'function')
      throw new TypeError(`An avalanche source with ${method}() is required`);
  const state = createState();
  const parts = {};
  const context = { state, services, parts, source };
  parts.rendering = createRendering(context);
  parts.presenter = createPresenter(context);
  parts.playback = createPlayback(context);
  parts.selection = createSelection(context);
  parts.ingestion = createIngestion(context);
  parts.controls = createControls(context);
  parts.lifecycle = createLifecycle(context);
  return Object.assign(
    {},
    parts.controls.methods,
    parts.lifecycle.methods,
    parts.ingestion.methods,
  );
}
export { createAvalancheSource } from './source.js';
