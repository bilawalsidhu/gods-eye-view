import { startApplicationChrome } from '../app/startupChrome.js';
import { playOpeningIntro } from '../app/openingIntro.js';
import { initKeySetup } from '../keySetup.js';
import { streetLevelFromParams } from '../view/index.js';
export function startStandaloneChrome(options) {
  // A Street Level link opens its photos at its view, so it plays no
  // opening. Read now: the address is rewritten once the link restores.
  const streetLevel = streetLevelFromParams(
    new URLSearchParams(globalThis.location?.hash.slice(1) ?? ''),
  );
  return startApplicationChrome({
    initializeSettings: initKeySetup,
    playOpening: streetLevel ? null : playOpeningIntro,
    ...options,
  });
}
