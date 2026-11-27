import { defaultSurface } from './surfaceServices.js';
import { createApplicationFlights } from '../app/layers/flights.js';

import { createFlightSource } from '../sources/live/standalone.js';
import * as militaryRegistry from './militaryRegistry.js';

const flightsLayer = createApplicationFlights({
  surface: defaultSurface,
  source: createFlightSource(),
  militaryRegistry,
});
export const mapAnalystRecord = flightsLayer.mapAnalystRecord;
export default flightsLayer;
