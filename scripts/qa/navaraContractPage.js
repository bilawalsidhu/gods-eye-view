// Dev-only page for scripts/qa-globe-contract.mjs --engine=navara: the Navara
// globe on a bare page (the app's ?engine=navara mode comes later). Not part
// of the production build, which only takes the application's own HTML.
import { createNavaraGlobe } from '../../src/globe/navara/index.js';

const state = {
  engine: null,
  view: null,
  error: null,
  createGlobe: createNavaraGlobe,
};
window.__globeQa = state;
try {
  const globe = await createNavaraGlobe({
    container: document.getElementById('globe'),
  });
  state.view = globe.view;
  state.engine = globe.engine;
  state.destroy = globe.destroy;
  // The browser key the dev server defines for the app (never printed).
  state.googleApiKey = import.meta.env.GOOGLE_MAPS_API_KEY || '';
} catch (error) {
  state.error = String(error?.stack || error);
}
state.ready = true;
