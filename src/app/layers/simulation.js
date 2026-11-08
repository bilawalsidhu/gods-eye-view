import { createSimulationLayer } from '../../layers/simulation/index.js';
import * as render from '../../renderGovernor.js';

/**
 * Construct the Simulation layer with the application's render governor and
 * asset base. Construction loads nothing; the scenario file is fetched on
 * enable and released on disable.
 */
export function createApplicationSimulation({
  resolveAsset = (url) =>
    `${import.meta.env?.BASE_URL || '/'}${url.replace(/^\//, '')}`,
  ...options
} = {}) {
  return createSimulationLayer({
    services: { render },
    resolveAsset,
    ...options,
  });
}
