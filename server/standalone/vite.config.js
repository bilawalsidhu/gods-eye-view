import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { resolveAllowedHosts } from '../../build/allowedHosts.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { localMcpPlugin } from '../mcp/plugin.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { standaloneVoiceTools } from './voiceTools.js';
import { unwatchedRuntimeDirsPlugin } from './unwatched-cache.js';
import { worldMonitorProxy } from '../providers/worldmonitor.js';
import { isWorldMonitorConfigured } from '../../src/tools/queries/worldmonitor.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const tools = standaloneVoiceTools();
  const worldMonitor = isWorldMonitorConfigured(process.env);
  const config = createBrowserViteConfig({
    plugins: [
      ...(worldMonitor ? [worldMonitorProxy()] : []),
      ...localProviderPlugins({ realtime: { tools }, gemini: { tools } }),
      localMcpPlugin(),
      apiNotFoundPlugin(),
      unwatchedRuntimeDirsPlugin(),
    ],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    mapillaryToken: process.env.MAPILLARY_CLIENT_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(process.env.GEV_ALLOWED_HOSTS),
    command,
  });
  // Only the switch reaches the browser; the World Monitor address and
  // credentials stay on this server.
  config.define['import.meta.env.GEV_WORLD_MONITOR_ENABLED'] =
    JSON.stringify(worldMonitor);
  return config;
});
