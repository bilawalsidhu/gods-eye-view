import { PHONEMIZER_RUNTIME } from '../modelCatalog.js';
import { createSha256 } from '../sha256.js';
import { MODEL_CACHE_NAME } from './modelCache.js';

// kokoro-js imports `phonemizer`; the build resolves that import to this
// module (build/onDeviceRuntime.js), so the phonemizer is never bundled or
// served from this origin. The first call downloads the pinned file from
// the public npm CDN, checks its SHA-256 and only then imports it.

let pending = null;

// A stalled download must not hold voice start; natural voice then falls
// back to a system voice.
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** SHA-256 of a byte array as lowercase hex. */
export function sha256Hex(bytes) {
  const hash = createSha256();
  hash.update(bytes);
  return hash.digest();
}

async function keptCopy(cachesApi, url) {
  try {
    const cache = await cachesApi?.open(MODEL_CACHE_NAME);
    const response = await cache?.match(url);
    return response ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function keepCopy(cachesApi, url, bytes) {
  try {
    const cache = await cachesApi?.open(MODEL_CACHE_NAME);
    await cache?.put(
      url,
      new Response(bytes, { headers: { 'content-type': 'text/javascript' } }),
    );
  } catch {
    /* storage refused; the next start downloads again */
  }
}

/**
 * Reads the kept copy or downloads the pinned phonemizer, verifies its
 * SHA-256 and imports it. A copy that fails the check is never imported.
 * @returns {Promise<{module: object, source: 'cache'|'network'}>}
 */
export function loadPhonemizer({
  runtime = PHONEMIZER_RUNTIME,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  cachesApi = globalThis.caches,
  importModule = importFromBytes,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
} = {}) {
  pending ||= (async () => {
    let bytes = await keptCopy(cachesApi, runtime.url);
    let source = 'cache';
    if (!bytes || sha256Hex(bytes) !== runtime.sha256) {
      source = 'network';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(runtime.url, {
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            `Natural voice component could not be downloaded (HTTP ${response.status})`,
          );
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        throw new Error('Natural voice component download timed out');
      } finally {
        clearTimeout(timer);
      }
      if (sha256Hex(bytes) !== runtime.sha256)
        throw new Error('Natural voice component failed its integrity check');
    }
    const module = await importModule(bytes);
    if (typeof module?.phonemize !== 'function')
      throw new Error('Natural voice component is not usable');
    if (source === 'network') await keepCopy(cachesApi, runtime.url, bytes);
    return { module, source };
  })();
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

async function importFromBytes(bytes) {
  const url = URL.createObjectURL(
    new Blob([bytes], { type: 'text/javascript' }),
  );
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The phonemizer API kokoro-js calls. */
export async function phonemize(text, language) {
  return (await loadPhonemizer()).module.phonemize(text, language);
}

export async function list_voices(language) {
  return (await loadPhonemizer()).module.list_voices(language);
}

/** Forgets a loaded or failed component (tests). */
export function resetPhonemizer() {
  pending = null;
}
