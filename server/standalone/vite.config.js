import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { resolveAllowedHosts } from '../../build/allowedHosts.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { localMcpPlugin } from '../mcp/plugin.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { conformanceReferencesPlugin } from './conformance-references.js';
import { googleTokenUnavailablePlugin } from './google-token-unavailable.js';
import { standaloneVoiceTools } from './voiceTools.js';
import { unwatchedRuntimeDirsPlugin } from './unwatched-cache.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Env-file values this process applied, kept across Vite restarts (the config module is re-bundled each time). */
const ENV_FILE_VALUES = Symbol.for('gev.standalone.envFileValues');

/**
 * Apply the env files' values without overriding the shell. A key applied from
 * a file earlier that no file sets any more is removed again, and a changed
 * value replaces the old one.
 * @param {() => Record<string, string>} read loadEnv's answer
 */
export function applyEnvFiles(read, env = process.env) {
  const previous = globalThis[ENV_FILE_VALUES] ?? new Map();
  for (const [key, value] of previous) if (env[key] === value) delete env[key];
  const applied = new Map();
  for (const [key, value] of Object.entries(read())) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    applied.set(key, value);
  }
  globalThis[ENV_FILE_VALUES] = applied;
}
/** Load this checkout's configuration and attach its local provider middleware. */
export function standaloneConfig(
  { command, mode },
  { nominatimStorageDir } = {},
) {
  applyEnvFiles(() => loadEnv(mode, root, ''));
  const tools = standaloneVoiceTools();
  return createBrowserViteConfig({
    plugins: [
      ...localProviderPlugins({
        realtime: { tools },
        gemini: { tools },
        nominatimStorageDir,
      }),
      localMcpPlugin(),
      googleTokenUnavailablePlugin(),
      conformanceReferencesPlugin(),
      apiNotFoundPlugin(),
      unwatchedRuntimeDirsPlugin(),
    ],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    photonUrl: process.env.PHOTON_URL,
    mapillaryToken: process.env.MAPILLARY_CLIENT_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(process.env.GEV_ALLOWED_HOSTS),
    command,
  });
}

export default defineConfig(standaloneConfig);
