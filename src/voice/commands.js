import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createRealtimeSession } from './realtimeSession.js';
import { createGeminiSession } from './geminiSession.js';
import { bindVoiceProviderToggle, readVoiceProvider } from './voiceProvider.js';

const SESSION_FACTORIES = Object.freeze({
  openai: createRealtimeSession,
  gemini: createGeminiSession,
});

/** Default composition; callers may supply another session adapter factory. */
export function createVoiceCommands(options, provider = readVoiceProvider()) {
  const controls = bindVoiceCommands({
    createSession: SESSION_FACTORIES[provider],
    ...options,
  });
  if (!options.createSession)
    bindVoiceProviderToggle({
      root: controls.session?.signal?.aborted
        ? null
        : document.getElementById('gev-voice-control'),
      provider,
      onSwitch: (next) => createVoiceCommands(options, next),
    });
  return controls;
}
