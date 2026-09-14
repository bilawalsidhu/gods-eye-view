import { createGevActionRunner } from './gevActions.js';
import { createVoiceCommands } from './commands.js';
export * from './realtimeController.js';

/** Compose the standalone action runner with the voice controls. */
export function initGevVoiceCommands(options) {
  return createVoiceCommands({ ...options, runner: createGevActionRunner(options) });
}
