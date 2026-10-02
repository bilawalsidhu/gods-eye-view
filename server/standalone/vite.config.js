import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { apiNotFoundPlugin } from './api-not-found.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Optional TLS for reaching the dev server from another machine: browsers only
 * grant the microphone to HTTPS or localhost pages.
 */
export function httpsOptions(env = process.env, read = readFileSync) {
  const cert = String(env.HTTPS_CERT_FILE || '').trim();
  const key = String(env.HTTPS_KEY_FILE || '').trim();
  if (!cert && !key) return undefined;
  if (!cert || !key)
    throw new Error('Set both HTTPS_CERT_FILE and HTTPS_KEY_FILE, or neither');
  return { cert: read(cert), key: read(key) };
}

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return createBrowserViteConfig({
    plugins: [...localProviderPlugins(), apiNotFoundPlugin()],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
    https: httpsOptions(),
    command,
  });
});
