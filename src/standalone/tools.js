import { createAssetDirectorySource } from '../director/packs/source.js';
import { createApplicationTools } from '../app/tools.js';
import { startStandaloneChrome } from './startupChrome.js';
import { loadToolCatalog } from './toolCatalog.js';
import { createHybridIntelligence } from '../ui/hybridIntelligence.js';
export function createStandaloneTools(options) {
  const tools = createApplicationTools({
    startChrome: startStandaloneChrome,
    sceneDataPacks: {
      sources: {
        assets: createAssetDirectorySource({
          // A panel names the app's address; see src/tools/globePanel.js.
          baseUrl: new URL(
            '/scene-assets/',
            globalThis.GEV_APP_BASE_URL ?? document.baseURI,
          ).href,
        }),
      },
    },
    ...options,
    voice: { toolCatalog: loadToolCatalog, ...options?.voice },
  });
  if (options?.hybrid?.enabled) {
    const panel = createHybridIntelligence({
      container: document.body,
      runAction: tools.voiceCommands.runner,
      signal: options.signal,
    });
    options.defer(() => panel.destroy());
    // The local profile supplies text tools, not microphone transcription.
    // Keep the existing runner for map actions, while the panel owns input.
    if (tools.voiceCommands.session?.adapter?.capabilities?.textOnly) {
      const voiceControl = document.getElementById('gev-voice-control');
      if (voiceControl) {
        const previousDisplay = voiceControl.style.display;
        voiceControl.style.display = 'none';
        options.defer(() => {
          voiceControl.style.display = previousDisplay;
        });
      }
    }
  }
  return tools;
}
