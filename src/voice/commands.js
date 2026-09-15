import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createRealtimeSession } from './realtimeSession.js';

/** Default composition; callers may supply another session adapter factory. */
export function createVoiceCommands(options) {
  return bindVoiceCommands({
    createSession: createRealtimeSession,
    ...options,
  });
}
