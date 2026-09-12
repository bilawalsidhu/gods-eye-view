import cesium from 'vite-plugin-cesium';

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  googleApiKey,
  cesiumToken,
  defaultLocale = '',
  secondaryLocale = '',
  host = 'localhost',
  port = 4173,
} = {}) {
  return {
    plugins: [cesium(), ...plugins],
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
      // Locale pair (i18n): the client's default + secondary UI locale. These
      // are NOT secrets and are read by src/i18n/locale.js, which falls back
      // to the built-in en+es pair for empty/invalid values. Explicit define
      // entries are required because Vite only auto-exposes VITE_-prefixed
      // vars on import.meta.env.
      'import.meta.env.GEV_DEFAULT_LOCALE': JSON.stringify(defaultLocale),
      'import.meta.env.GEV_SECONDARY_LOCALE': JSON.stringify(secondaryLocale),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
