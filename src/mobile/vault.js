import { INSECURE_BACKEND, storageBackend } from './secureStorage.js';

/**
 * On-device per-provider key vault (interface layer; the Keystore-backed
 * store it deserves is still open — see `secureStorage.js`).
 *
 * The vault never imports Capacitor: callers inject a storage object with
 * the Capacitor Preferences shape, so a future secure plugin can be passed
 * through `withBackend(store, 'secure')` with no vault change:
 *
 * ```
 * {
 *   get({ key }) -> Promise<{ value: string | null }>,
 *   set({ key, value }) -> Promise<void>,
 *   remove({ key }) -> Promise<void>,
 * }
 * ```
 *
 * Values are never logged and never appear in a thrown error: `readKey`
 * never throws (null on any failure, including unknown ids), and
 * `writeKey`/`removeKey` failures are rethrown with sanitized messages
 * naming only the key id. Writes to an insecure backend are refused unless
 * the caller passes `insecureOk: true`.
 *
 * @module mobile/vault
 */

/** Provider key ids the vault owns, in contract order. */
export const KEY_IDS = Object.freeze([
  'OPENAI_API_KEY',
  'AISSTREAM_API_KEY',
  'FIRMS_MAP_KEY',
  'TOMTOM_API_KEY',
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
  'GOOGLE_MAPS_API_KEY',
]);

/**
 * Whether a key id belongs to the vault contract.
 * @param {string} id Candidate key id.
 * @returns {boolean} True only for a listed `KEY_IDS` entry.
 */
export function isKeyId(id) {
  return KEY_IDS.includes(id);
}

/**
 * Reject with a sanitized error naming only the key id (never a value).
 * @param {string} verb Operation label (`read`, `write`, `remove`).
 * @param {string} id Vault key id.
 * @returns {never} Always throws.
 */
function failFor(verb, id) {
  throw new Error(`vault ${verb} failed for ${id}`);
}

/**
 * Create a vault over an injected Preferences-shaped store.
 * @param {{ storage: { get: Function, set: Function, remove: Function }, insecureOk?: boolean }} options Injected store plus the insecure-backend opt-in.
 * @returns {{ readKey: Function, writeKey: Function, removeKey: Function, keyStatus: Function }} Vault operations.
 */
export function createVault({ storage, insecureOk = false } = {}) {
  if (
    !storage ||
    typeof storage.get !== 'function' ||
    typeof storage.set !== 'function' ||
    typeof storage.remove !== 'function'
  ) {
    throw new TypeError(
      'createVault needs storage with {get, set, remove} functions',
    );
  }
  const backend = storageBackend(storage);
  const writable = backend !== INSECURE_BACKEND || insecureOk === true;

  /**
   * Read one provider key. Never throws: unknown ids, empty values, and
   * storage failures all resolve to null.
   * @param {string} id Vault key id.
   * @returns {Promise<string|null>} Stored value, or null when unset or unreadable.
   */
  async function readKey(id) {
    if (!isKeyId(id)) return null;
    try {
      const result = await storage.get({ key: id });
      const value = result?.value;
      if (typeof value !== 'string' || !value) return null;
      return value;
    } catch {
      return null;
    }
  }

  /**
   * Persist one provider key. Rejects unknown ids, empty/non-string
   * values, writes to an insecure backend without `insecureOk`, and
   * storage failures; thrown messages never carry the value.
   * @param {string} id Vault key id.
   * @param {string} value Key value (non-empty string).
   * @returns {Promise<void>}
   */
  async function writeKey(id, value) {
    if (!isKeyId(id)) throw new TypeError(`unknown vault key id: ${id}`);
    if (typeof value !== 'string' || !value) {
      throw new TypeError(`vault write for ${id} needs a non-empty string`);
    }
    if (!writable) {
      throw new Error(`vault write for ${id} refused on an insecure backend`);
    }
    try {
      await storage.set({ key: id, value });
    } catch {
      failFor('write', id);
    }
  }

  /**
   * Delete one provider key. Rejects unknown ids and storage failures;
   * thrown messages never carry a value.
   * @param {string} id Vault key id.
   * @returns {Promise<void>}
   */
  async function removeKey(id) {
    if (!isKeyId(id)) throw new TypeError(`unknown vault key id: ${id}`);
    try {
      await storage.remove({ key: id });
    } catch {
      failFor('remove', id);
    }
  }

  /**
   * Report presence (never values) for every vault key. Fails closed:
   * unreadable entries resolve to `set: false` rather than throwing.
   * @returns {Promise<Record<string, { set: boolean, backend: 'secure'|'insecure' }>>} Presence per key id.
   */
  async function keyStatus() {
    const status = {};
    for (const id of KEY_IDS) {
      let set = false;
      try {
        const result = await storage.get({ key: id });
        set = typeof result?.value === 'string' && result.value.length > 0;
      } catch {
        set = false;
      }
      status[id] = { set, backend };
    }
    return status;
  }

  return { readKey, writeKey, removeKey, keyStatus };
}
