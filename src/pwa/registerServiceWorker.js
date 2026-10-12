/**
 * Register the app-shell service worker in production builds served over a
 * secure context (HTTPS or localhost). Dev servers never register it, so local
 * development keeps Vite's live module graph.
 * @param {{ prod?: boolean, nav?: Navigator, win?: Window }} [options]
 * @returns {Promise<ServiceWorkerRegistration|null>}
 */
export async function registerServiceWorker({
  prod = import.meta.env?.PROD === true,
  nav = globalThis.navigator,
  win = globalThis.window,
} = {}) {
  if (!prod || !win?.isSecureContext || !nav?.serviceWorker) return null;
  try {
    return await nav.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (error) {
    console.warn('[PWA] Service worker registration failed:', error);
    return null;
  }
}
