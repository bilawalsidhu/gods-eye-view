import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';
import { embedFramingPlugin } from './embed-framing.js';
import { panelBuildPlugin } from './panel.js';

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  host = '127.0.0.1',
  port = 4173,
  command,
} = {}) {
  return {
    plugins: [
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
      ],
    },
    server: {
      // 'localhost' can resolve to ::1 only on some systems, leaving IPv4
      // clients (including sandboxed browsers and `curl 127.0.0.1`) with
      // connection refused on launch. Pin the default to the IPv4 loopback
      // so http://localhost:4173 works everywhere; HOST still overrides
      // (e.g. 0.0.0.0 for LAN sharing, which also widens allowedHosts).
      host: host && host !== 'localhost' ? host : '127.0.0.1',
      port: parseInt(port, 10) || 4173,
      allowedHosts:
        host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // These headers protect the document containing Provider Settings.
      // Embed-mode documents are framable instead; see embed-framing.js.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
