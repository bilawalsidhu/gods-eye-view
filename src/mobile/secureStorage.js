/**
 * Backend tag for the secure-storage bridge.
 *
 * The vault never imports Capacitor: callers inject a Preferences-shaped
 * store and this module only labels it. The only store reachable from JS
 * today is Capacitor Preferences (unencrypted `SharedPreferences`), so the
 * bridge reports `backend: 'insecure'` until a Keystore-backed vehicle
 * (for example `@aparajita/capacitor-secure-storage` or
 * `@capawesome-team/capacitor-secure-preferences`, both maintained for
 * Capacitor 8) is vendored and wrapped with `withBackend(store, 'secure')`.
 * No custom native plugin is built here; the seam is ready for one.
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
