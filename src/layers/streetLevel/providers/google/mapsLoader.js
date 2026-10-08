/**
 * Loads the Google Maps JavaScript API once per page, on first use, and hands
 * out its libraries. Google calls `gm_authFailure` when it refuses the key
 * (an unknown key, a referrer it does not allow, or the Maps JavaScript API
 * not enabled for it); that reaches every `onAuthFailure` listener.
 */

const SCRIPT_ORIGIN = 'https://maps.googleapis.com';
const READY_CALLBACK = '__gevGoogleMapsReady';

/**
 * @param {{getApiKey: () => string|null|undefined, document?: Document, global?: object}} options
 */
export function createMapsLoader({
  getApiKey,
  document = globalThis.document,
  global = globalThis,
}) {
  /** The script load in flight or done; cleared when it fails, so a retry can. */
  let loading = null;
  let authFailed = false;
  let authHandlerInstalled = false;
  const authListeners = new Set();

  /** Once per loader: a retried load must not wrap its own handler again. */
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
    if (loading) return loading;
    const key = getApiKey?.();
    if (!key)
      return Promise.reject(new Error('GOOGLE_MAPS_API_KEY is not set'));
    if (global.google?.maps?.importLibrary)
      return (loading = Promise.resolve(global.google.maps));
    installAuthHandler();
    loading = new Promise((resolve, reject) => {
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
        loading = null;
        script.remove();
        delete global[READY_CALLBACK];
        reject(new Error('The Google Maps JavaScript API could not load'));
      };
      document.head.append(script);
    });
    return loading;
  }

  return {
    /** A Maps library ('streetView', …), loading the API first. */
    async importLibrary(name) {
      const maps = await load();
      return maps.importLibrary(name);
    },
    /** Whether Google has refused the key on this page. */
    authFailed: () => authFailed,
    onAuthFailure(listener) {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },
  };
}
