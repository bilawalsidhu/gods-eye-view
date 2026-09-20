import { startApplicationChrome } from '../app/startupChrome.js';
import { initKeySetup } from '../keySetup.js';
export function startStandaloneChrome(options) {
  return startApplicationChrome({
    initializeSettings: initKeySetup,
    ...options,
  });
}
