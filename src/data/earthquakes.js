import { createUsgsEarthquakeSource } from '../layers/earthquakes/index.js';
import { createApplicationEarthquakes } from '../app/layers/earthquakes.js';
export * from '../layers/earthquakes/index.js';
/** Wire the standalone source and application overlay owner. */
export function createEarthquakesLayer({
  source = createUsgsEarthquakeSource(),
  ...options
} = {}) {
  return createApplicationEarthquakes({ source, ...options });
}
export default createEarthquakesLayer();
