import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { apiNotFoundPlugin } from './api-not-found.js';

/**
 * Hosted deployment configuration (Render and equivalents).
 *
 * The same checkout and the same provider middleware as `npm run dev`, served
 * against the built bundle: every provider declares `configurePreviewServer`,
 * so `vite preview` brokers the API routes exactly as the dev server does.
 * The one provider that does not — in-app credential editing — refuses to
 * attach outside development by design, so a public deployment cannot be
 * talked into writing keys to disk.
 *
 * What differs from `vite.config.js` is only what a managed host dictates:
 * the port it hands us, the hostname it routes on, and cache headers for
 * content-hashed assets that the dev server has no reason to set.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));

const DEFAULT_PORT = 10000;

/**
 * Hostnames this deployment answers to.
 *
 * Vite rejects a request whose Host header is not allow-listed, which is what
 * stops DNS rebinding from reaching the key-brokering proxies. Render exports
 * its own hostname; custom domains and preview aliases are declared through
 * GEV_ALLOWED_HOSTS. With neither set there is no hostname to pin, and
 * refusing every request would take the whole deployment down, so the check
 * is relaxed rather than failed closed.
 *
 * @param {object} [env] Environment to read.
 * @returns {string[]|true} Allow-list, or `true` to accept any Host.
 */
export function deploymentAllowedHosts(env = process.env) {
  const declared = String(env.GEV_ALLOWED_HOSTS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const hosts = [env.RENDER_EXTERNAL_HOSTNAME, ...declared].filter(Boolean);
  return hosts.length ? [...new Set(hosts)] : true;
}

/** Port the host assigns, falling back to the documented default. */
export function deploymentPort(env = process.env) {
  const port = Number.parseInt(env.PORT, 10);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}

/**
 * Cache the immutable build output and never the document.
 *
 * Asset filenames carry a content hash, so they can be cached for a year;
 * `index.html` names them and must be revalidated or a deploy would keep
 * serving the previous bundle.
 */
export function immutableAssetCaching() {
  const install = (server) => {
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
      next();
    });
  };
  return {
    name: 'gev-immutable-asset-caching',
    configureServer: install,
    configurePreviewServer: install,
  };
}

export default defineConfig(({ mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const config = createBrowserViteConfig({
    plugins: [
      immutableAssetCaching(),
      ...localProviderPlugins(),
      apiNotFoundPlugin(),
    ],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    host: process.env.HOST || '0.0.0.0',
    port: process.env.PORT,
  });
  return {
    ...config,
    preview: {
      host: process.env.HOST || '0.0.0.0',
      port: deploymentPort(),
      // A silent fall back to another port would answer the platform's health
      // check on a socket nothing is routed to.
      strictPort: true,
      allowedHosts: deploymentAllowedHosts(),
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  };
});
