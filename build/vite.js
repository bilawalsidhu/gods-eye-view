import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';
import { DEFAULT_ALLOWED_HOSTS, hostCheckPlugin } from './allowedHosts.js';
import { embedFramingPlugin } from './embed-framing.js';
import { panelBuildPlugin } from './panel.js';

/**
 * Content-Security-Policy for every document the dev/preview server serves.
 * No inline script is permitted, and the only foreign script origins are the
 * three that the Bhote Koshi event's embedded media needs (YouTube, Facebook
 * and X), which frame-src matches for their players and posts. 'unsafe-eval' is
 * required: Knockout (bundled inside @cesium/widgets) resolves the global
 * object with `(0, eval)("this")` at module load, and without it the Cesium
 * widget never initializes (verified in headless Chrome). It also covers
 * Cesium's WASM decoders. `blob:` is required in the built app: Cesium's
 * bundled workers bootstrap through `importScripts(blob:...)`, which a worker
 * checks against script-src (the dev server loads them by URL instead).
 * Widen any other directive only for a real violation.
 */
export const BROWSER_CSP = [
  "default-src 'self'",
  // The Bhote Koshi event's embedded media: the YouTube player API, the
  // Facebook video SDK and X's post widget (src/data/bhoteKoshiEmbeddedMedia.js);
  // and the Maps JavaScript API that Street Level's Google Street View runs on.
  "script-src 'self' 'unsafe-eval' blob: https://www.youtube.com https://connect.facebook.net https://platform.twitter.com https://maps.googleapis.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' blob: data: https: wss: ws:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  // The same media's players and posts, which load in frames.
  "frame-src 'self' blob: https://www.youtube-nocookie.com https://www.youtube.com https://www.facebook.com https://platform.twitter.com",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Response headers shared by the dev and preview servers. */
export const BROWSER_HEADERS = Object.freeze({
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': BROWSER_CSP,
  // Responses are only ever used as the type the server declares.
  'X-Content-Type-Options': 'nosniff',
});

/**
 * Content-Security-Policy for every `/api` response. API routes return data,
 * never a document, so a response opened directly in a tab gets no origin and
 * can load nothing.
 */
export const API_CSP = "default-src 'none'; sandbox";

/** Response headers every `/api` response carries. */
export const API_HEADERS = Object.freeze({
  'Content-Security-Policy': API_CSP,
  'X-Content-Type-Options': 'nosniff',
});

/**
 * Whether a request reaches an `/api` mount, by the router's own rule: the
 * prefix compared without case and followed by the end, `/` or `.`. The router
 * reads an absolute-form target's path without resolving dot segments, so the
 * path is taken here the same way (scheme and authority dropped, backslashes as
 * slashes), alongside the raw and the fully parsed path; any match counts.
 */
function isApiPath(url) {
  const raw = String(url || '/');
  const target = raw
    .trim()
    .split(/[?#]/, 1)[0]
    .replace(/\\/g, '/')
    .replace(/^[a-z][a-z0-9+.-]*:(?:\/\/[^/]*)?/i, '');
  let parsed = '';
  try {
    parsed = new URL(raw, 'http://localhost').pathname;
  } catch {
    /* the unparsed paths still decide */
  }
  return [raw.split(/[?#]/, 1)[0], target, parsed].some((path) =>
    /^\/api(?:$|[/.])/i.test(path),
  );
}

/**
 * Vite plugin that sets API_HEADERS on every API response before any other
 * middleware runs, so success, error, partial, refused and unknown-route
 * answers all carry them. Vite's `server.headers` and `preview.headers` only
 * reach the documents and assets Vite serves itself. A route may still add
 * headers; a route's own Content-Security-Policy is sent as an additional
 * policy, which can only restrict further, never replace this one.
 */
export function apiResponseHeadersPlugin() {
  const install = (server) => {
    server.middlewares.use((req, res, next) => {
      if (!isApiPath(req.url)) return next();
      for (const [name, value] of Object.entries(API_HEADERS))
        res.setHeader(name, value);
      const setHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) =>
        String(name).toLowerCase() === 'content-security-policy' &&
        String(value) !== API_CSP
          ? setHeader(name, `${API_CSP}, ${value}`)
          : setHeader(name, value);
      next();
    });
  };
  return {
    name: 'api-response-headers',
    enforce: 'pre',
    configureServer: install,
    configurePreviewServer: install,
  };
}

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  mapillaryToken,
  host = 'localhost',
  port = 4173,
  allowedHosts = DEFAULT_ALLOWED_HOSTS,
  command,
} = {}) {
  return {
    plugins: [
      // First, so every API response, including a Host refusal, carries them.
      apiResponseHeadersPlugin(),
      // Next, so no provider route answers a Host the server does not allow.
      hostCheckPlugin(),
      cesium(),
      applicationHtmlPlugin(),
      ...plugins,
      embedFramingPlugin(),
      panelBuildPlugin(),
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
        // Loaded on demand when the first street-level image opens.
        'mapillary-js',
      ],
    },
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      // A wildcard bind only chooses interfaces; it never disables Vite's
      // Host-header check. LAN hostnames are added explicitly (see
      // build/allowedHosts.js); IP addresses are always accepted.
      allowedHosts: [...allowedHosts],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // These headers protect the document containing Provider Settings and
      // give the whole page a real Content-Security-Policy (BROWSER_CSP).
      // Embed-mode documents are framable instead: embed-framing.js rewrites
      // only the frame-ancestors directive and keeps the rest of the policy.
      headers: BROWSER_HEADERS,
    },
    // The preview server serves the same documents, so it carries the same
    // framing + CSP hardening (one constant, no drift).
    preview: { headers: BROWSER_HEADERS },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
      // Mapillary client tokens are public by design (see SECURITY.md).
      'import.meta.env.MAPILLARY_CLIENT_TOKEN': JSON.stringify(
        mapillaryToken ?? '',
      ),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
