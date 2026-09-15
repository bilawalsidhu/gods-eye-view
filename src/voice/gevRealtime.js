import { requestProviderSettings } from '../keySetup.js';
import { createGevActionRunner } from './gevActions.js';
import { createVoiceCommands } from './commands.js';
export * from './realtimeController.js';

/** Compose the standalone action runner with the voice controls. */
export function initGevVoiceCommands(options) {
  return createVoiceCommands({
    ...options,
    openProviderSettings: options.openProviderSettings || requestProviderSettings,
    runner: createGevActionRunner(options),
  });
}
