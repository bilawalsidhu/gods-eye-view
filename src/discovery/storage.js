import { validateDiscoveryPack } from './model.js';
const KEY = 'gods-eye-view.discovery.public.v1';
/** Public library only: private area/mandate cases never use this store. */
export function createDiscoveryStorage(storage = null) {
  if (!storage) {
    try {
      storage = globalThis.localStorage;
    } catch {
      storage = null;
    }
  }
  return {
    load() {
      try {
        const text = storage.getItem(KEY);
        return text && text.length < 2 * 1024 * 1024
          ? validateDiscoveryPack(JSON.parse(text))
          : null;
      } catch {
        return null;
      }
    },
    save(pack) {
      if (!storage)
        throw new Error('Persistent storage is unavailable in this host.');
      const value = validateDiscoveryPack(pack);
      const text = JSON.stringify(value);
      if (new TextEncoder().encode(text).length > 2 * 1024 * 1024)
        throw new Error('Library limit is 2 MiB.');
      storage.setItem(KEY, text);
      return value;
    },
    clear() {
      storage?.removeItem(KEY);
    },
  };
}
async function digest(payload, cryptoApi) {
  const bytes = await cryptoApi.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
export async function exportDiscoveryFile(pack, cryptoApi = globalThis.crypto) {
  const payload = validateDiscoveryPack(pack);
  return {
    format: 'gods-eye-view/discovery-file',
    version: 1,
    sha256: await digest(payload, cryptoApi),
    payload,
  };
}
export async function importDiscoveryFile(text, cryptoApi = globalThis.crypto) {
  if (
    typeof text !== 'string' ||
    new TextEncoder().encode(text).length > 2 * 1024 * 1024
  )
    throw new Error('Pack limit is 2 MiB.');
  const file = JSON.parse(text);
  if (
    file.format !== 'gods-eye-view/discovery-file' ||
    file.version !== 1 ||
    file.sha256 !== (await digest(file.payload, cryptoApi))
  )
    throw new Error('Pack checksum mismatch.');
  return validateDiscoveryPack(file.payload);
}
