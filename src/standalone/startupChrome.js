import { startApplicationChrome } from '../app/startupChrome.js';
import { initKeySetup } from '../keySetup.js';
export function startStandaloneChrome(options) {
  return startApplicationChrome({
    // MzansiView's places drawer replaces the upstream first-run mission card.
    initializeWelcome: null,
    initializeSettings: initKeySetup,
    ...options,
  });
}
