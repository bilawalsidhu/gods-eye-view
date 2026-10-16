/**
 * Loads the Google Maps JavaScript API once per page, on first use. Google's
 * `gm_authFailure` (key refused) reaches every `onAuthFailure` listener.
 */

const SCRIPT_ORIGIN = 'https://maps.googleapis.com';
const READY_CALLBACK = '__gevGoogleMapsReady';
/** The page's one script load, shared by every loader on it. */
const PAGE_LOAD = Symbol.for('gev.googleMapsLoad');

/**
 * @param {{getApiKey: () => string|null|undefined, document?: Document, global?: object}} options
 */
export function createMapsLoader({
  getApiKey,
  document = globalThis.document,
  global = globalThis,
}) {
  let authFailed = false;
  let authHandlerInstalled = false;
  const authListeners = new Set();

  /** Once per loader: a retry must not wrap its own handler. */
  function installAuthHandler() {
    if (authHandlerInstalled) return;
    authHandlerInstalled = true;
    const previous = global.gm_authFailure;
    global.gm_authFailure = () => {
      authFailed = true;
      for (const listener of [...authListeners]) {
        try {
          listener();
        } catch {
          /* a listener's error is its own */
        }
      }
      if (typeof previous === 'function') previous();
    };
  }

  function load() {
    const key = getApiKey?.();
    if (!key)
      return Promise.reject(new Error('GOOGLE_MAPS_API_KEY is not set'));
    installAuthHandler();
    if (global[PAGE_LOAD]) return global[PAGE_LOAD];
    if (global.google?.maps?.importLibrary)
      return Promise.resolve(global.google.maps);
    const loading = new Promise((resolve, reject) => {
      global[READY_CALLBACK] = () => {
        delete global[READY_CALLBACK];
        resolve(global.google.maps);
      };
      const script = document.createElement('script');
      script.async = true;
      script.src = `${SCRIPT_ORIGIN}/maps/api/js?${new URLSearchParams({
        key,
        v: 'weekly',
        loading: 'async',
        callback: READY_CALLBACK,
      })}`;
      script.onerror = () => {
        if (global[PAGE_LOAD] === loading) delete global[PAGE_LOAD];
        script.remove();
        delete global[READY_CALLBACK];
        reject(new Error('The Google Maps JavaScript API could not load'));
      };
      document.head.append(script);
    });
    global[PAGE_LOAD] = loading;
    return loading;
  }

  return {
    async importLibrary(name) {
      const maps = await load();
      return maps.importLibrary(name);
    },
    authFailed: () => authFailed,
    onAuthFailure(listener) {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },
  };
}
