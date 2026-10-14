import { createStreetLevelLayer } from '../../layers/streetLevel/index.js';
import { createMapillaryProvider } from '../../layers/streetLevel/providers/mapillary/index.js';
import { createGoogleProvider } from '../../layers/streetLevel/providers/google/index.js';
import { createKartaViewProvider } from '../../layers/streetLevel/providers/kartaview/index.js';
import { createVegbilderProvider } from '../../layers/streetLevel/providers/vegbilder/index.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as input from '../../data/inputOwnership.js';
import * as scenePick from '../../data/scenePick.js';
import * as render from '../../renderGovernor.js';

/** The browser Maps key the scene was started with (src/app/scene.js). */
const googleApiKey = () => globalThis.window?.__GOOGLE_MAPS_API_KEY__ || null;

/**
 * Mapillary, Google Street View, KartaView and Vegbilder, once the Mapillary
 * source is supplied; else none.
 */
function defaultProviders(sources) {
  if (sources.mapillary == null) return [];
  return [
    createMapillaryProvider({ source: sources.mapillary }),
    createGoogleProvider({ getApiKey: googleApiKey }),
    createKartaViewProvider(),
    createVegbilderProvider(),
  ];
}

/**
 * Inject providers, or use the defaults. An explicit provider list replaces
 * them; an unused sources.mapillary is neither constructed nor validated,
 * including when the list is empty.
 */
export function createApplicationStreetLevel({
  surface,
  sources = {},
  providers = defaultProviders(sources),
}) {
  return createStreetLevelLayer({
    providers,
    services: {
      sprites,
      picking,
      input,
      scenePick,
      render,
      ground: surface?.groundFloor ?? null,
      meshFloor: surface?.meshFloor ?? null,
      terrain: surface?.terrain ?? null,
    },
  });
}
