import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createRealtimeSession } from './realtimeSession.js';
import { createGeminiSession } from './geminiSession.js';
import { createProviderCommands } from './providerCommands.js';

/** Standalone provider selection; embedders may still supply their own adapter. */
export function createVoiceCommands(options) {
  if (options.createSession) return bindVoiceCommands(options);
  return createProviderCommands(options, {
    bind: bindVoiceCommands,
    factories: { openai: createRealtimeSession, gemini: createGeminiSession },
  });
}
