import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createRealtimeSession } from './realtimeSession.js';
import { createGeminiSession } from './geminiSession.js';
import { createProviderCommands } from './providerCommands.js';
import { createVoicePanelHost } from './panel/host.js';

/** Default composition; callers may supply another session adapter factory. */
export function createVoiceCommands(options = {}) {
  const panelHost =
    options.panel === true
      ? createVoicePanelHost({
          storage: options.panelStorage,
          clock: options.panelClock,
          readCockpitState: options.styleManager?.getCockpitState
            ? () => options.styleManager.getCockpitState()
            : undefined,
        })
      : null;
  const bind = (settings) =>
    bindVoiceCommands({
      ...settings,
      ...(panelHost
        ? {
            panelHost,
            nativePanelProvider: settings.createController
              ? null
              : settings.createSession === createRealtimeSession
                ? 'openai'
                : settings.createSession === createGeminiSession
                  ? 'gemini'
                  : null,
          }
        : {}),
    });
  let commands;
  // Generic hosts retain the existing default; standalone opts in explicitly.
  if (!options.createSession && options.supportedProviders !== undefined)
    commands = createProviderCommands(options, {
      bind,
      factories: { openai: createRealtimeSession, gemini: createGeminiSession },
    });
  else commands = bind({ createSession: createRealtimeSession, ...options });
  if (panelHost) {
    const lifetime = commands.signal ?? commands.session?.signal;
    lifetime?.addEventListener('abort', () => panelHost.destroy(), {
      once: true,
    });
    if (lifetime?.aborted) panelHost.destroy();
  }
  return commands;
}
