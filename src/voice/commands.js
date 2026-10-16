import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createRealtimeSession } from './realtimeSession.js';
import { createGeminiSession } from './geminiSession.js';
import { createProviderCommands } from './providerCommands.js';
import { supportedVoiceProviders } from './providerCapabilities.js';

/** Standalone provider selection; embedders may still supply their own adapter. */
export function createVoiceCommands(options) {
  if (options.createSession) return bindVoiceCommands(options);
  const factories = {
    openai: createRealtimeSession,
    gemini: createGeminiSession,
  };
  const supportedProviders = supportedVoiceProviders(
    options.supportedProviders,
    factories,
  );
  return createProviderCommands(
    { ...options, supportedProviders },
    {
      bind: bindVoiceCommands,
      factories: Object.fromEntries(
        supportedProviders.map((name) => [name, factories[name]]),
      ),
    },
  );
}
