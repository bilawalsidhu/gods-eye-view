import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { apiNotFoundPlugin } from './api-not-found.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Load only the environment variables required by this Vite configuration.
 * Avoid copying the entire environment into process.env.
 */
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, root, '');

  const host = env.HOST || process.env.HOST;
  const port = env.PORT || process.env.PORT;

  const googleApiKey =
    env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

  const cesiumToken =
    env.CESIUM_ION_TOKEN || process.env.CESIUM_ION_TOKEN;

  return createBrowserViteConfig({
    plugins: [
      ...localProviderPlugins(),
      apiNotFoundPlugin(),
    ],

    googleApiKey,
    cesiumToken,

    host,
    port,

    command,
  });
});
