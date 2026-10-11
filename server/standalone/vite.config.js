import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { resolveAllowedHosts } from '../../build/allowedHosts.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { localMcpPlugin } from '../mcp/plugin.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { standaloneVoiceTools } from './voiceTools.js';
import { localModelProxy } from '../providers/local-model.js';
import { worldMonitorProxy } from '../providers/worldmonitor.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const localModelSelected = Boolean(process.env.GEV_LLM_PROVIDER?.trim());
  const config = createBrowserViteConfig({
    plugins: [
      localModelProxy({ tools: standaloneVoiceTools() }),
      worldMonitorProxy(),
      ...localProviderPlugins({ realtime: { tools: standaloneVoiceTools() } }),
      localMcpPlugin(),
      apiNotFoundPlugin(),
    ],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    mapillaryToken: process.env.MAPILLARY_CLIENT_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(process.env.GEV_ALLOWED_HOSTS),
    command,
  });
  // Only public feature switches enter the browser bundle. Provider URLs,
  // credentials, and credential-file paths remain on the local server.
  config.define['import.meta.env.GEV_HYBRID_ENABLED'] = JSON.stringify(
    process.env.GEV_HYBRID_ENABLED === 'true' || localModelSelected,
  );
  config.define['import.meta.env.GEV_LOCAL_MODEL_SELECTED'] =
    JSON.stringify(localModelSelected);
  return config;
});
