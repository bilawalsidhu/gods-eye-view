import { createStreetLevelLayer } from '../../layers/streetLevel/index.js';
import { createMapillaryProvider } from '../../layers/streetLevel/mapillaryProvider.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as input from '../../data/inputOwnership.js';
import * as render from '../../renderGovernor.js';

/**
 * Inject providers, or use Mapillary only when its source is supplied.
 * An explicit provider list replaces the default; an unused sources.mapillary
 * is neither constructed nor validated, including when the list is empty.
 */
export function createApplicationStreetLevel({
  sources = {},
  providers = sources.mapillary == null
    ? []
    : [createMapillaryProvider({ source: sources.mapillary })],
}) {
  return createStreetLevelLayer({
    providers,
    services: { sprites, picking, input, render },
  });
}
