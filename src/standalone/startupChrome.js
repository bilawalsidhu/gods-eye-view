import { startApplicationChrome } from '../app/startupChrome.js';
import { playOpeningIntro } from '../app/openingIntro.js';
import { initKeySetup } from '../keySetup.js';
export function startStandaloneChrome(options) {
  return startApplicationChrome({
    initializeSettings: initKeySetup,
    playOpening: playOpeningIntro,
    ...options,
  });
}
