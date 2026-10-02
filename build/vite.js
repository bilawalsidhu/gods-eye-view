import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';
import {
  onDeviceRuntimePlugin,
  phonemizerLoaderPath,
} from './onDeviceRuntime.js';

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  host = 'localhost',
  port = 4173,
  naturalVoice,
  command,
} = {}) {
  return {
    plugins: [
      cesium(),
      applicationHtmlPlugin(),
      onDeviceRuntimePlugin(),
      ...plugins,
    ],
    // Workers are bundled separately and need the on-device runtime too.
    worker: { plugins: () => [onDeviceRuntimePlugin()] },
    // Also applied while pre-bundling kokoro-js for the dev server.
    resolve: {
      alias: [{ find: /^phonemizer$/, replacement: phonemizerLoaderPath() }],
    },
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
        '@litert-lm/core',
        '@huggingface/transformers',
        'kokoro-js',
      ],
    },
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      allowedHosts:
        host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // These headers protect the document containing Provider Settings.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
      // GEV_NATURAL_VOICE=off leaves natural (Kokoro) voice out of the
      // on-device tier; replies use the browser's on-device voices or text.
      'import.meta.env.GEV_NATURAL_VOICE': JSON.stringify(naturalVoice ?? ''),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
