import { createAssetDirectorySource } from '../director/packs/source.js';
import { createApplicationTools } from '../app/tools.js';
import { startStandaloneChrome } from './startupChrome.js';
import { loadToolCatalog } from './toolCatalog.js';
import { createWorldMonitorBriefing } from '../ui/worldMonitorBriefing.js';
export function createStandaloneTools(options) {
  const worldMonitor = Boolean(options?.worldMonitor?.enabled);
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
    voice: {
      supportedProviders: ['openai', 'gemini'],
      toolCatalog: () => loadToolCatalog({ worldMonitor }),
      ...options?.voice,
    },
  });
  if (worldMonitor) {
    const briefing = createWorldMonitorBriefing({
      container: document.body,
      signal: options.signal,
    });
    options.defer(() => briefing?.destroy());
  }
  return tools;
}
