import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import {
  allowedHostsFromEnv,
  createBrowserViteConfig,
} from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { scrubUnresolvedKeyVaultReferences } from '../../scripts/secret-env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  // Before any provider reads a key: an App Service Key Vault reference that
  // did not resolve reaches the process as its literal text, not as a key.
  scrubUnresolvedKeyVaultReferences(process.env);
  return createBrowserViteConfig({
    plugins: [...localProviderPlugins(), apiNotFoundPlugin()],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: allowedHostsFromEnv(process.env),
    command,
  });
});
