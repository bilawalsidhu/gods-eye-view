import { createStreetLevelLayer } from '../../layers/streetLevel/index.js';
import { createMapillaryProvider } from '../../layers/streetLevel/providers/mapillary/index.js';
import { createGoogleProvider } from '../../layers/streetLevel/providers/google/index.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as input from '../../data/inputOwnership.js';
import * as scenePick from '../../data/scenePick.js';
import * as render from '../../renderGovernor.js';

/** The browser Maps key the scene was started with (src/app/scene.js). */
const googleApiKey = () => globalThis.window?.__GOOGLE_MAPS_API_KEY__ || null;

/** A new provider registers here; its chip, credit and share bit follow. */
export function createApplicationStreetLevel({ surface, sources }) {
  return createStreetLevelLayer({
    providers: [
      createMapillaryProvider({ source: sources.mapillary }),
      createGoogleProvider({ getApiKey: googleApiKey }),
    ],
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
