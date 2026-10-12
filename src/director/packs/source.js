import { PACK_LIMITS, validateAssetPath } from './manifest.js';

/** Register a fixed asset directory. Scene files cannot replace its origin or escape its path. */
export function createAssetDirectorySource({
  baseUrl,
  fetchImpl = globalThis.fetch,
}) {
  const base = new URL(baseUrl);
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !base.pathname.endsWith('/')
  )
    throw new TypeError(
      'Asset source requires an explicit HTTP(S) directory URL',
    );
  return async ({ path, signal, maxBytes = PACK_LIMITS.bytes }) => {
    validateAssetPath(path);
    signal?.throwIfAborted();
    const response = await fetchImpl(new URL(path, base).href, {
      signal,
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Asset unavailable');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Asset stream unavailable');
    const chunks = [];
    let length = 0;
    try {
      if (Number(response.headers.get('content-length')) > maxBytes)
        throw new Error('Asset exceeds byte limit');
      for (;;) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) throw new Error('Asset exceeds byte limit');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      bytes,
      mimeType: (response.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase(),
    };
  };
}
