import { createSha256 } from '../sha256.js';
import { teeWithBackpressure } from '../streamTee.js';

export const MODEL_CACHE_NAME = 'gev-local-voice-models-v1';

/**
 * Counts and optionally hashes a download. It errors instead of closing when
 * the stream is shorter than expected or the digest differs, so a truncated
 * or altered file is never cached or loaded.
 */
function verifiedStream(source, { total, sha256, phase, onProgress }) {
  const reader = source.getReader();
  let resolveVerified;
  let rejectVerified;
  const verified = new Promise((resolve, reject) => {
    resolveVerified = resolve;
    rejectVerified = reject;
  });
  verified.catch(() => {});
  const hash = sha256 ? createSha256() : null;
  let loaded = 0;
  let lastReport = 0;
  const stream = new ReadableStream(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            onProgress?.(loaded, total, phase);
            if (total && loaded !== total)
              throw new Error(
                `Model download ended early (${loaded} of ${total} bytes)`,
              );
            if (hash && hash.digest() !== sha256)
              throw new Error('Model file failed its integrity check');
            controller.close();
            resolveVerified();
            return;
          }
          loaded += value.byteLength;
          hash?.update(value);
          const now = performance.now();
          if (now - lastReport > 250) {
            lastReport = now;
            onProgress?.(loaded, total, phase);
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
          rejectVerified(error);
          reader.cancel(error).catch(() => {});
        }
      },
      cancel(reason) {
        rejectVerified(reason || new Error('Download cancelled'));
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, verified };
}

async function openCache(cachesApi) {
  try {
    return { cache: await cachesApi.open(MODEL_CACHE_NAME), error: null };
  } catch (error) {
    return { cache: null, error };
  }
}

/**
 * Opens a model file as a stream: from the Cache API when present, otherwise
 * from the network while writing the same bytes to the cache with bounded
 * buffering. Returns `cacheWrite`, which settles with whether the model will
 * be kept for the next session.
 */
export async function openModelStream(
  url,
  {
    bytes = 0,
    sha256 = null,
    onProgress,
    signal,
    cachesApi = globalThis.caches,
    fetchImpl = (...args) => fetch(...args),
  } = {},
) {
  const { cache, error: cacheError } = cachesApi
    ? await openCache(cachesApi)
    : { cache: null, error: new Error('Cache API unavailable') };
  const cached = cache ? await cache.match(url).catch(() => null) : null;
  if (cached?.body) {
    const total = Number(cached.headers.get('content-length')) || bytes;
    const { stream } = verifiedStream(cached.body, {
      total,
      phase: 'cache',
      onProgress,
    });
    return {
      fromCache: true,
      total,
      stream,
      finish: async () => {},
      cacheWrite: Promise.resolve({ ok: true, cached: true }),
    };
  }
  const response = await fetchImpl(url, { signal });
  if (!response.ok || !response.body)
    throw new Error(`Model download failed (${response.status})`);
  const total = Number(response.headers.get('content-length')) || bytes;
  const download = verifiedStream(response.body, {
    total,
    sha256,
    phase: 'download',
    onProgress,
  });
  // The loader may stop reading once it has what it needs; the second
  // branch reads to the end so the file is always verified and cached.
  const { primary, secondary, releasePrimary, releaseSecondary, drain } =
    teeWithBackpressure(download.stream);
  // A failed cache write stops reading its branch; it must not hold the
  // loader behind backpressure or leave the download unverified.
  let secondaryDropped = false;
  let primaryReleased = false;
  const cacheWrite = cache
    ? cache
        .put(
          url,
          new Response(secondary, {
            headers: {
              'content-type': 'application/octet-stream',
              ...(total ? { 'content-length': String(total) } : {}),
            },
          }),
        )
        .then(
          () => ({ ok: true }),
          (error) => {
            secondaryDropped = true;
            releaseSecondary();
            // Nobody reads the rest if the loader already finished.
            if (primaryReleased) drain().catch(() => {});
            return { ok: false, error: error?.message || String(error) };
          },
        )
    : (async () => {
        for await (const chunk of secondary) void chunk;
        return {
          ok: false,
          error: `Model cache unavailable: ${cacheError?.message || cacheError}`,
        };
      })().catch((error) => ({ ok: false, error: error?.message }));
  return {
    fromCache: false,
    total,
    stream: primary,
    /**
     * Call once the loader is done with the stream. Resolves when the whole
     * download has been verified; rejects if it was cut short or altered.
     */
    async finish() {
      primaryReleased = true;
      releasePrimary();
      if (secondaryDropped) await drain();
      await download.verified;
    },
    cacheWrite,
  };
}

/** Whether a model file is already cached. */
export async function isModelCached(url, cachesApi = globalThis.caches) {
  try {
    const cache = await cachesApi.open(MODEL_CACHE_NAME);
    return Boolean(await cache.match(url));
  } catch {
    return false;
  }
}
