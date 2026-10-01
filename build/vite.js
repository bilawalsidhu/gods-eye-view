import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';
import { isIP } from 'node:net';

const LOOPBACK_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '.local'];

/**
 * Deployment hostnames the dev/preview host check should accept, read from an
 * explicit environment object (never `process.env` directly): App Service's
 * WEBSITE_HOSTNAME plus a comma-separated GEV_ALLOWED_HOSTS for custom domains.
 * Wildcard spellings (`true`, `*`) are dropped so the check can never be
 * switched off from configuration.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
export function allowedHostsFromEnv(env = {}) {
  const hosts = [
    env.WEBSITE_HOSTNAME,
    ...String(env.GEV_ALLOWED_HOSTS || '').split(','),
  ];
  return hosts
    .map((host) => String(host || '').trim())
    .filter(
      (host) =>
        host &&
        host !== '*' &&
        host.toLowerCase() !== 'true' &&
        // App Service hands over an unresolved reference as literal text.
        !host.startsWith('@Microsoft.KeyVault('),
    );
}

/**
 * The configured bind host as an allow-list entry (`HOST=DESKTOP-X` lets the
 * machine's own name reach /api, as Vite itself would). Wildcard binds
 * (`0.0.0.0`, `::`, `*`, `true`) name no host and add nothing.
 *
 * @param {unknown} host
 * @returns {string[]}
 */
function bindHostEntries(host) {
  if (typeof host !== 'string') return [];
  const value = host.trim();
  if (!value || value === '*' || value.toLowerCase() === 'true') return [];
  if (isIP(value.replace(/^\[|\]$/g, ''))) return []; // IP literals already pass
  return [value];
}

/**
 * Whether a Host header names an allowed host. Mirrors Vite's own
 * `allowedHosts` semantics: IP literals and `localhost`/`*.localhost` always
 * pass; a list entry matches exactly, and an entry with a leading dot also
 * matches its subdomains.
 *
 * @param {string|undefined} hostHeader
 * @param {string[]} allowList
 * @returns {boolean}
 */
export function isAllowedHost(hostHeader, allowList) {
  const value = String(hostHeader || '').trim();
  if (!value) return false;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 && isIP(value.slice(1, end)) === 6;
  }
  const colon = value.indexOf(':');
  const hostname = (colon === -1 ? value : value.slice(0, colon)).toLowerCase();
  if (isIP(hostname) === 4) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  return allowList.some((entry) => {
    const allowed = String(entry).toLowerCase();
    if (allowed === hostname) return true;
    return (
      allowed.startsWith('.') &&
      (allowed.slice(1) === hostname || hostname.endsWith(allowed))
    );
  });
}

/**
 * Host allow-list for `/api/*`, mounted ahead of every provider middleware.
 * Vite's own host check is added after the middlewares plugins register in
 * configureServer/configurePreviewServer, so without this the providers
 * would answer a DNS-rebinding Host before Vite ever looked at it.
 *
 * @param {string[]} allowList
 * @returns {import('vite').Plugin}
 */
export function apiHostGuardPlugin(allowList) {
  const guard = (req, res, next) => {
    if (isAllowedHost(req.headers?.host, allowList)) return next();
    res.writeHead(403, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ error: 'Host not allowed' }));
  };
  const install = (server) => {
    server.middlewares.use('/api', guard);
  };
  return {
    name: 'gev-api-host-guard',
    enforce: 'pre',
    configureServer: { order: 'pre', handler: install },
    configurePreviewServer: { order: 'pre', handler: install },
  };
}

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  host = 'localhost',
  port = 4173,
  allowedHosts = [],
  command,
} = {}) {
  // Never `true`: even on a wildcard bind (container, 0.0.0.0) Vite's host
  // check stays on and accepts only loopback plus explicit deployment hosts.
  const hostAllowList = [
    ...new Set([
      ...LOOPBACK_ALLOWED_HOSTS,
      ...allowedHosts,
      ...bindHostEntries(host),
    ]),
  ];
  return {
    plugins: [
      cesium(),
      applicationHtmlPlugin(),
      ...plugins,
      // Last in the list, first to run: `enforce`/`order: 'pre'` mount it
      // ahead of every provider's /api middleware.
      apiHostGuardPlugin(hostAllowList),
    ],
    ...(publicDir === undefined ? {} : { publicDir }),
    // A production build must not clean the dependency cache a running dev
    // server is still serving optimized module URLs from.
    ...(command === 'build' ? { cacheDir: 'node_modules/.vite-build' } : {}),
    optimizeDeps: {
      // First reached through the SDR worker or a dynamic import. Pre-bundle
      // them at startup so first use cannot invalidate already-transformed
      // URLs with Vite's "Outdated Optimize Dep" 504 response.
      include: [
        '@jtarrio/signals/demod/demodulator.js',
        '@jtarrio/signals/demod/modes.js',
        '@jtarrio/webrtlsdr/rtlsdr.js',
        'egm96-universal',
      ],
    },
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      allowedHosts: hostAllowList,
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // These headers protect the document containing Provider Settings.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    // `vite preview` (the production server for this repo — see server/standalone/
    // vite.config.js) reads its own host/port from `preview`, NOT `server`, and
    // otherwise defaults to port 4173 regardless of PORT/HOST env vars.
    preview: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      allowedHosts: hostAllowList,
      // Preview is the deployed server (behind App Service TLS). HSTS is only
      // honoured by browsers over HTTPS, so a local http preview is unaffected.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
        'Strict-Transport-Security': 'max-age=31536000',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      },
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
