/**
 * Backend tag for the secure-storage bridge.
 *
 * The vault never imports Capacitor: callers inject a Preferences-shaped
 * store and this module only labels it. Two stores exist:
 *
 * - Secure (Keystore/Keychain): `@aparajita/capacitor-secure-storage`
 *   8.0.1 (MIT, Capacitor 8 — AES-GCM with an Android Keystore-held key,
 *   iOS Keychain), vendored as a dependency and wrapped by
 *   `secureStoreFromPlugin` into the Preferences shape the vault speaks.
 *   It loads only inside the native shell (`loadSecureStore` refuses
 *   anywhere else — the plugin's web fallback is unencrypted
 *   `localStorage`, strictly a debugging aid).
 * - Insecure fallback: Capacitor Preferences (unencrypted
 *   `SharedPreferences`) or the `localStorage` adapter, tagged
 *   `backend: 'insecure'` via `insecureBridge`.
 *
 * `loadVaultStorage` prefers the secure store and falls back to Preferences
 * (still flagged insecure, still bannered in Provider Settings). No custom
 * native plugin is built here.
 *
 * @module mobile/secureStorage
 */

/** Backend label for Keystore/Keychain-backed storage. */
export const SECURE_BACKEND = 'secure';

/** Backend label for unencrypted stores such as Capacitor Preferences. */
export const INSECURE_BACKEND = 'insecure';

/**
 * Read the backend label of an injected store. Anything that is not
 * explicitly tagged secure counts as insecure (fail closed).
 * @param {{ backend?: string }|null|undefined} storage Injected store.
 * @returns {'secure'|'insecure'} Backend label, defaulting to insecure.
 */
export function storageBackend(storage) {
  return storage?.backend === SECURE_BACKEND
    ? SECURE_BACKEND
    : INSECURE_BACKEND;
}

/**
 * Tag an injected Preferences-shaped store with its backend class. The
 * wrapper delegates `get`/`set`/`remove` untouched and only exposes the
 * `backend` label the vault reports in `keyStatus`.
 * @param {{ get: Function, set: Function, remove: Function }} storage Injected Preferences-shaped store.
 * @param {'secure'|'insecure'} backend Backend class of the store.
 * @returns {{ get: Function, set: Function, remove: Function, backend: string }} Tagged store.
 */
export function withBackend(storage, backend) {
  if (backend !== SECURE_BACKEND && backend !== INSECURE_BACKEND) {
    throw new TypeError('secureStorage backend must be secure or insecure');
  }
  return {
    get: (options) => storage.get(options),
    set: (options) => storage.set(options),
    remove: (options) => storage.remove(options),
    backend,
  };
}

/**
 * Tag a store known to be unencrypted (Capacitor Preferences, the
 * `localStorage` adapter) so the vault reports `backend: 'insecure'`.
 * @param {{ get: Function, set: Function, remove: Function }} storage Injected Preferences-shaped store.
 * @returns {{ get: Function, set: Function, remove: Function, backend: string }} Store tagged insecure.
 */
export function insecureBridge(storage) {
  return withBackend(storage, INSECURE_BACKEND);
}

/** Package id of the vendored Keystore/Keychain vehicle. */
export const SECURE_STORAGE_PLUGIN_ID = '@aparajita/capacitor-secure-storage';

/**
 * Whether this page runs inside the native Capacitor shell. The plugin's
 * web fallback is unencrypted `localStorage`, so the secure store is only
 * ever attempted natively — everywhere else `loadSecureStore` refuses
 * without importing anything.
 * @returns {boolean} True only when `Capacitor.isNativePlatform()` says so.
 */
export function isNativeCapacitorHost() {
  try {
    const host = globalThis.Capacitor;
    if (!host || typeof host.isNativePlatform !== 'function') return false;
    return host.isNativePlatform() === true;
  } catch {
    return false;
  }
}

/**
 * Wrap a secure-storage plugin instance into the Preferences-shaped store
 * the vault speaks, tagged `backend: 'secure'`. The plugin's string API
 * (`getItem`/`setItem`/`removeItem`) maps one-to-one onto vault values,
 * which are always strings.
 * @param {{ getItem: Function, setItem: Function, removeItem: Function }} plugin Secure-storage plugin instance.
 * @returns {{ get: Function, set: Function, remove: Function, backend: string }} Secure-tagged store.
 */
export function secureStoreFromPlugin(plugin) {
  if (
    !plugin ||
    typeof plugin.getItem !== 'function' ||
    typeof plugin.setItem !== 'function' ||
    typeof plugin.removeItem !== 'function'
  ) {
    throw new TypeError(
      'secureStoreFromPlugin needs getItem/setItem/removeItem functions',
    );
  }
  return withBackend(
    {
      get: async ({ key }) => ({ value: await plugin.getItem(key) }),
      set: async ({ key, value }) => {
        await plugin.setItem(key, String(value));
      },
      remove: async ({ key }) => {
        await plugin.removeItem(key);
      },
    },
    SECURE_BACKEND,
  );
}

/** Default import function for the secure storage plugin. */
async function importSecureStoragePlugin() {
  const module = await import('@aparajita/capacitor-secure-storage');
  return module;
}

/**
 * Load the Keystore/Keychain-backed store, or null when it is unavailable.
 * Refuses (without importing) outside the native shell; on-device a missing
 * or unsynced plugin (any import or probe failure) also resolves to null so
 * the caller falls back to Preferences — still flagged insecure.
 * @param {{ importPlugin?: Function, isNative?: boolean }} options Import and platform seams (tests inject both).
 * @returns {Promise<{ get: Function, set: Function, remove: Function, backend: string }|null>} Secure store, or null.
 */
export async function loadSecureStore({
  importPlugin = importSecureStoragePlugin,
  isNative,
} = {}) {
  const native = isNative === undefined ? isNativeCapacitorHost() : isNative;
  if (native !== true) return null;
  try {
    const module = await importPlugin();
    const plugin = module?.SecureStorage ?? module?.default ?? null;
    if (!plugin) return null;
    // Probe that the native implementation answers with a real round-trip
    // (an unsynced plugin rejects here). Use a benign key that is never
    // user-visible; values are never read — presence + latency is enough.
    // Support both the modern `get` API and the legacy `getKeyPrefix` API.
    if (typeof plugin.get === 'function') {
      await plugin.get({ key: '__secure_storage_probe__' });
    } else if (typeof plugin.getKeyPrefix === 'function') {
      await plugin.getKeyPrefix();
    } else {
      throw new Error('Secure storage plugin missing get/getKeyPrefix');
    }
    return secureStoreFromPlugin(plugin);
  } catch {
    return null;
  }
}

/**
 * Resolve the vault's storage: the secure store when it loads, otherwise
 * the injected Preferences-shaped fallback tagged insecure. Never throws —
 * an unusable fallback resolves to `{ store: null, backend: 'insecure' }`
 * so surfaces can render presence-free rather than crash.
 * @param {{ get: Function, set: Function, remove: Function }|null} preferences Injected Preferences-shaped fallback.
 * @param {{ loadSecure?: Function }} options Secure-loader seam for tests.
 * @returns {Promise<{ store: { get: Function, set: Function, remove: Function, backend: string }|null, backend: 'secure'|'insecure' }>} Store plus its backend label.
 */
export async function loadVaultStorage(
  preferences,
  { loadSecure = loadSecureStore } = {},
) {
  try {
    const secure = await loadSecure();
    if (secure) return { store: secure, backend: SECURE_BACKEND };
  } catch {
    // Fall through to Preferences — still flagged insecure.
  }
  if (
    preferences &&
    typeof preferences.get === 'function' &&
    typeof preferences.set === 'function' &&
    typeof preferences.remove === 'function'
  ) {
    return { store: insecureBridge(preferences), backend: INSECURE_BACKEND };
  }
  return { store: null, backend: INSECURE_BACKEND };
}
