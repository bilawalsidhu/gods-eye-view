import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import standaloneConfig from '../server/standalone/vite.config.js';
import { accessGate } from './access-gate.js';

/**
 * Hosted-deployment config: this checkout's standalone config, plus the pieces
 * a platform needs that a localhost launch does not.
 *
 * `vite preview` is the production entrypoint because every provider in
 * server/providers/ registers `configurePreviewServer` alongside
 * `configureServer` — so the built bundle in dist/ is served with the live-data
 * proxies attached. The in-app key-setup writer is dev-only (`apply: 'serve'`)
 * and stays absent here, which is what makes a hosted preview server safe to
 * expose at all.
 */

const root = fileURLToPath(new URL('../', import.meta.url));

/** A platform hands the app a hostname it cannot know in advance. */
function allowedHosts() {
  const configured = process.env.GEV_ALLOWED_HOSTS?.trim();
  if (!configured) return true;
  return configured
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export default defineConfig(async (env) => {
  const base = await standaloneConfig(env);
  const host = process.env.HOST || '0.0.0.0';
  const port = Number.parseInt(process.env.PORT, 10) || 8080;
  return {
    ...base,
    root,
    // First in the list is first in the middleware chain, so the gate runs
    // ahead of static files and every provider proxy.
    plugins: [accessGate(), ...(base.plugins ?? [])],
    preview: {
      host,
      port,
      // A silently different port is worse than a failed boot: the platform
      // health check would hit nothing.
      strictPort: true,
      allowedHosts: allowedHosts(),
      // The document that can hold provider credentials must not be framed.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
  };
});
