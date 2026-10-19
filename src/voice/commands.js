import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createConfiguredSession } from './configuredSession.js';

/** Default composition; callers may supply another session adapter factory. */
export function createVoiceCommands(options) {
  return bindVoiceCommands({
    createSession: createConfiguredSession,
    ...options,
  });
}
