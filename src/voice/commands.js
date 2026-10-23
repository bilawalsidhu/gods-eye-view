import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createRealtimeSession } from './realtimeSession.js';
import { createGeminiSession } from './geminiSession.js';
import { createProviderCommands } from './providerCommands.js';

/** Default composition; callers may supply another session adapter factory. */
export function createVoiceCommands(options = {}) {
  // Generic hosts retain the existing default; standalone opts in explicitly.
  if (!options.createSession && options.supportedProviders !== undefined)
    return createProviderCommands(options, {
      bind: bindVoiceCommands,
      factories: { openai: createRealtimeSession, gemini: createGeminiSession },
    });
  return bindVoiceCommands({
    createSession: createRealtimeSession,
    ...options,
  });
}
