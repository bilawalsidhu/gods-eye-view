/**
 * Vault-backed key reader for application boot.
 *
 * The on-device direct adapters take per-key readers (`getKey(id)`), but
 * nothing connects them to the vault at startup — so every keyed feed
 * reports its key missing even with a full vault. This module builds that
 * reader: lazily (first key read triggers vault init, never slowing boot),
 * fail-closed (any failure resolves `null`, preserving legacy keyless
 * behavior), and dynamic-imported so the web bundle never pulls native
 * storage code paths at module-evaluation time.
 *
 * @module mobile/vaultKeys
 */

/**
 * Create a `getKey(id)` reader backed by the on-device vault.
 * @param {{ loadVault?: Function, readKey?: Function }} options Seams for tests: `loadVault()` resolves a vault-like `{ readKey }`, or `readKey` directly.
 * @returns {Function} `async (id) -> string|null`, fail-closed.
 */
export function createVaultKeyReader({ loadVault, readKey } = {}) {
  let vaultPromise = null;
  const load = () => {
    if (readKey) return Promise.resolve({ readKey });
    if (!loadVault) return Promise.resolve(null);
    if (!vaultPromise) {
      vaultPromise = Promise.resolve()
        .then(() => loadVault())
        .catch(() => null);
    }
    return vaultPromise;
  };
  return async function getVaultKey(id) {
    if (typeof id !== 'string' || !id) return null;
    try {
      const vault = await load();
      if (!vault || typeof vault.readKey !== 'function') return null;
      const value = await vault.readKey(id);
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  };
}

/**
 * Default vault loader: secure store when it loads, Preferences-shaped
 * fallback otherwise (both report through `loadVaultStorage`; reads stay
 * fail-closed, so a missing store simply yields keyless feeds).
 * @param {{ loadVaultStorage?: Function, createVault?: Function, loadPreferences?: Function }} options Seams for tests.
 * @returns {Promise<{ readKey: Function }|null>} Vault-like handle, or null.
 */
export async function loadDefaultVault({
  loadVaultStorage,
  createVault,
  loadPreferences,
} = {}) {
  try {
    const [{ loadVaultStorage: resolveStorage }, { createVault: makeVault }] =
      await Promise.all([
        loadVaultStorage ? { loadVaultStorage } : import('./secureStorage.js'),
        createVault ? { createVault } : import('./vault.js'),
      ]);
    const preferences = loadPreferences
      ? await loadPreferences().catch(() => null)
      : null;
    const { store } = await resolveStorage(preferences);
    if (!store) return null;
    return makeVault({ storage: store });
  } catch {
    return null;
  }
}

/**
 * Application-boot key reader: `getKey` for the standalone catalog, backed
 * by the default vault. Resolves `null` per key until and unless the vault
 * loads — never throws, never blocks boot.
 * @returns {Function} `async (id) -> string|null`.
 */
export function createApplicationKeyReader() {
  return createVaultKeyReader({
    loadVault: () =>
      loadDefaultVault({
        loadPreferences: () =>
          import('../keySetup.js').then((m) => m.loadDefaultCapacitorStorage()),
      }),
  });
}
