import { createAssetDirectorySource } from '../director/packs/source.js';
import { createApplicationTools } from '../app/tools.js';
import { startStandaloneChrome } from './startupChrome.js';
import { loadToolCatalog } from './toolCatalog.js';
import { mountMzansiExplorer } from './mzansi/mount.js';
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
    voice: {
      supportedProviders: ['openai', 'gemini'],
      panel: true,
      toolCatalog: loadToolCatalog,
      ...options?.voice,
    },
  });
  options.defer(
    mountMzansiExplorer({
      viewer: options.scene.viewer,
      navigation: options.controls.styleManager,
    }),
  );
  return tools;
}
