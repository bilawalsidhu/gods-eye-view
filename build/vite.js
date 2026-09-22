import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  host = 'localhost',
  port = 4173,
} = {}) {
  return {
    plugins: [cesium(), applicationHtmlPlugin(), ...plugins],
    ...(publicDir === undefined ? {} : { publicDir }),
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      // SECURITY: never set allowedHosts to `true` — it disables Vite's
      // hostname verification entirely, enabling DNS rebinding attacks
      // where a malicious website re-resolves its domain to 127.0.0.1
      // and makes authenticated requests to the local dev server,
      // exfiltrating API keys and manipulating credentials.
      allowedHosts: ['localhost', '127.0.0.1', '::1', '.local'],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // These headers protect the document containing Provider Settings.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
        // SECURITY: prevent MIME-type sniffing on ALL responses — without
        // this, a browser may interpret a JSON API response as HTML and
        // execute embedded script when the response echoes user-controlled
        // data (content-type confusion → XSS in older browsers).
        'X-Content-Type-Options': 'nosniff',
      },
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
