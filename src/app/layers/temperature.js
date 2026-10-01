import { createTemperatureLayer } from '../../layers/temperature/index.js';
import * as render from '../../renderGovernor.js';
import { overlayHost as overlay } from './overlayHost.js';

/** Wire the surface-temperature overlay to the application render and overlay hosts. */
export function createApplicationTemperature({ source }) {
  return createTemperatureLayer({ source, services: { render, overlay } });
}
