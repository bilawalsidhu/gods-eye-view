import { API_BASE_STORAGE_KEY, resolveApiBase } from './runtimeConfig.js';

/**
 * BYOK backend-URL store for the mobile shell (interface only in this plan;
 * full encrypted storage is Plan 2).
 *
 * The store never imports Capacitor: callers inject a storage object with the
 * Capacitor Preferences shape, so the real `Preferences` plugin can be passed
 * directly with no adapter:
 *
 * ```
 * {
 *   get({ key }) -> Promise<{ value: string | null }>,
 *   set({ key, value }) -> Promise<void>,
 *   remove({ key }) -> Promise<void>,
 * }
 * ```
 *
 * Validation always delegates to `resolveApiBase`, so only `https://host`
 * bases persist and anything else fails closed to `''` (same-origin). Values
 * are never logged.
 *
 * @module mobile/keyStore
 */

/**
 * Read the stored backend base, resolved and fail-closed.
 * @param {{ get: (options: { key: string }) => Promise<{ value: string | null }> }} storage Injected Preferences-shaped store.
 * @returns {Promise<string>} Resolved base, or `''` (same-origin) when unset,
 * invalid, or unreadable.
 */
export async function readApiBase(storage) {
  try {
    const result = await storage.get({ key: API_BASE_STORAGE_KEY });
    return resolveApiBase(result?.value ?? '');
  } catch {
    return '';
  }
}

/**
 * Persist a backend base override. Empty or invalid values clear the override
 * instead of persisting, so the app falls back to same-origin.
 * @param {{ set: (options: { key: string, value: string }) => Promise<void>, remove: (options: { key: string }) => Promise<void> }} storage Injected Preferences-shaped store.
 * @param {string} value Untrusted base value.
 * @returns {Promise<void>}
 */
export async function writeApiBase(storage, value) {
  const resolved = resolveApiBase(value);
  if (!resolved) {
    await storage.remove({ key: API_BASE_STORAGE_KEY });
    return;
  }
  await storage.set({ key: API_BASE_STORAGE_KEY, value: resolved });
}
