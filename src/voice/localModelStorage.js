// Bounded Cache Storage entries survive interrupted multi-GB downloads.
// Keep v1 whole-file entries readable; users do not need to re-download them.
export const MODEL_CHUNK_SIZE = 16 * 1024 * 1024;

export function modelFileParts(file) {
  if (file.size <= MODEL_CHUNK_SIZE)
    return [{ url: file.url, size: file.size, start: 0, end: file.size - 1 }];
  const parts = [];
  for (let start = 0; start < file.size; start += MODEL_CHUNK_SIZE) {
    const end = Math.min(start + MODEL_CHUNK_SIZE, file.size) - 1;
    const url = new URL(file.url);
    url.searchParams.set('gev-model-part', `${start}-${end}`);
    parts.push({ url: url.href, size: end - start + 1, start, end });
  }
  return parts;
}

export const hasCachedSize = (response, size) =>
  response?.headers.get('X-GEV-Model-Size') === String(size);

export async function cachedFileBytes(cache, file) {
  if (hasCachedSize(await cache.match(file.url), file.size)) return file.size;
  if (file.size <= MODEL_CHUNK_SIZE) return 0;
  let bytes = 0;
  for (const part of modelFileParts(file))
    if (hasCachedSize(await cache.match(part.url), part.size))
      bytes += part.size;
  return bytes;
}

/** Present saved parts to inference as one normal response, without networking. */
export async function readCachedModelFile(cache, file) {
  const whole = await cache.match(file.url);
  if (hasCachedSize(whole, file.size)) return whole;
  if (
    file.size <= MODEL_CHUNK_SIZE ||
    (await cachedFileBytes(cache, file)) !== file.size
  )
    return undefined;
  const parts = modelFileParts(file);
  let index = 0,
    reader,
    cancelled = false;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        while (!cancelled) {
          if (!reader) {
            if (index === parts.length) {
              controller.close();
              return;
            }
            const part = parts[index++];
            const response = await cache.match(part.url);
            if (cancelled) {
              await response?.body?.cancel();
              return;
            }
            if (!hasCachedSize(response, part.size) || !response.body)
              throw new Error(
                'Cached model data is missing. Download this model again.',
              );
            reader = response.body.getReader();
          }
          const next = await reader.read();
          if (cancelled) return;
          if (next.done) {
            reader.releaseLock();
            reader = null;
            continue;
          }
          controller.enqueue(next.value);
          return;
        }
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader?.cancel(reason);
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(file.size),
      'X-GEV-Model-Size': String(file.size),
    },
  });
}

export async function deleteCachedModelFile(cache, file) {
  await cache.delete(file.url);
  if (file.size > MODEL_CHUNK_SIZE)
    for (const part of modelFileParts(file)) await cache.delete(part.url);
}

function downloadError(message, retryable = false) {
  return Object.assign(new Error(message), { retryable });
}

function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Buffer at most one 16 MiB part so Cache.put cannot hide a broken network body. */
async function fetchPart(file, part, { signal, fetchImpl, onProgress }) {
  const ranged = file.size > MODEL_CHUNK_SIZE;
  const response = await fetchImpl(file.url, {
    signal,
    credentials: 'omit',
    cache: 'no-store',
    ...(ranged
      ? { headers: { Range: `bytes=${part.start}-${part.end}` } }
      : {}),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw downloadError(
      `Download failed (HTTP ${response.status}).`,
      response.status >= 500 || [408, 429].includes(response.status),
    );
  }
  if (
    ranged &&
    (response.status !== 206 ||
      response.headers.get('Content-Range') !==
        `bytes ${part.start}-${part.end}/${file.size}`)
  ) {
    await response.body.cancel();
    throw downloadError(
      'The model server returned an incorrect download range. Retry later.',
    );
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  const bytes = new Uint8Array(part.size);
  let received = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (received + value.byteLength > part.size)
        throw downloadError('Unexpected model file size');
      bytes.set(value, received);
      received += value.byteLength;
      onProgress(received);
    }
    if (received !== part.size)
      throw downloadError(
        'Download incomplete. Saved parts are kept; retry to continue.',
        true,
      );
    return bytes;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function downloadModelPart(
  file,
  part,
  { cache, signal, fetchImpl, onProgress, retryDelays = [500, 1500] },
) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const attemptSignal = AbortSignal.any(
        [signal, AbortSignal.timeout(120000)].filter(Boolean),
      );
      const bytes = await fetchPart(file, part, {
        signal: attemptSignal,
        fetchImpl,
        onProgress,
      });
      signal?.throwIfAborted();
      await cache.put(
        part.url,
        new Response(bytes, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(part.size),
            'X-GEV-Model-Size': String(part.size),
          },
        }),
      );
      // A completed part is useful even when the user cancelled during put().
      signal?.throwIfAborted();
      return;
    } catch (error) {
      signal?.throwIfAborted();
      onProgress(0);
      if (error.name === 'QuotaExceededError')
        throw new Error(
          'Browser storage is full. Remove a cached model and retry.',
        );
      if (error.retryable === false) throw error;
      if (attempt >= retryDelays.length)
        throw new Error(
          `Could not download ${file.url.split('/').at(-1)} (part ${Math.floor(part.start / MODEL_CHUNK_SIZE) + 1}). Saved parts are kept; retry to continue. ${error.message}`,
        );
      await pause(retryDelays[attempt], signal);
    }
  }
}
