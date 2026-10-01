import { createState } from './state.js';
import { createIngestion } from './ingestion.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createSampling } from './sampling.js';
import { createPlayback } from './playback.js';
import { createFilmstrip } from './filmstrip.js';

/** Construct the surface-temperature year playback with a supplied frame source. */
export function createTemperatureLayer({ services, source }) {
  if (typeof source?.resolveLatest !== 'function')
    throw new TypeError('A temperature frame source is required');
  if (typeof source?.sample !== 'function')
    throw new TypeError('A temperature point sampler is required');
  if (typeof source?.resolveYear !== 'function')
    throw new TypeError('A temperature year resolver is required');
  const state = createState();
  const parts = {};
  const context = { state, services, parts, source };
  parts.sampling = createSampling(context);
  parts.filmstrip = createFilmstrip(context);
  parts.playback = createPlayback(context);
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
export { createTemperatureSource } from './source.js';
export { createTemperatureSampler } from './sampler.js';
