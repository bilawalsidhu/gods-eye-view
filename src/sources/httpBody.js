/**
 * Wait for transport cleanup, with a bound for broken/nonconforming streams.
 * Native fetch cancellation closes this consumer's response stream; it is not
 * an acknowledgement that a remote model has stopped executing the request.
 */
async function cancelReadableBounded(readable, timeoutMs = 1000) {
  if (!readable) return;
  let timer;
  try {
    const cancellation = Promise.resolve()
      .then(() => readable.cancel())
      .catch(() => {});
    await Promise.race([
      cancellation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error('Upstream response cleanup timed out'), {
                code: 'RESPONSE_CLEANUP_TIMEOUT',
              }),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Cancel an unread response body and wait for bounded transport cleanup. */
export function cancelResponseBodyBounded(response, { timeoutMs = 1000 } = {}) {
  return cancelReadableBounded(response.body, timeoutMs);
}

/**
 * Read a fetch() Response body as text with a hard byte cap. Rejects early on an
 * oversized Content-Length, then streams with a running cap so a chunked or
 * length-omitted response cannot blow past the limit. Throws { code:'RESPONSE_TOO_LARGE' }.
 */
export async function readResponseTextCapped(response, maxBytes, signal) {
  const tooLarge = () =>
    Object.assign(new Error('Upstream response too large'), {
      code: 'RESPONSE_TOO_LARGE',
    });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponseBodyBounded(response);
    throw tooLarge();
  }
  if (signal?.aborted) {
    await cancelResponseBodyBounded(response);
    signal.throwIfAborted();
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    signal?.throwIfAborted();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw tooLarge();
    return text;
  }
  let cancellation;
  const cancel = () => {
    cancellation ??= cancelReadableBounded(reader);
    // An abort event cannot await us; the read's catch below owns settlement.
    void cancellation.catch(() => {});
    return cancellation;
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge();
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  } catch (error) {
    await cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Parse a fetch() JSON response only after enforcing a hard byte cap. */
export async function readResponseJsonCapped(response, maxBytes, signal) {
  return JSON.parse(await readResponseTextCapped(response, maxBytes, signal));
}

/**
 * Read a fetch() Response body as bytes with the same hard cap as
 * readResponseTextCapped — for protobuf upstreams (GTFS-Realtime).
 * Throws { code:'RESPONSE_TOO_LARGE' }.
 */
export async function readResponseBytesCapped(response, maxBytes, signal) {
  const tooLarge = () =>
    Object.assign(new Error('Upstream response too large'), {
      code: 'RESPONSE_TOO_LARGE',
    });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponseBodyBounded(response);
    throw tooLarge();
  }
  if (signal?.aborted) {
    await cancelResponseBodyBounded(response);
    signal.throwIfAborted();
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    signal?.throwIfAborted();
    if (bytes.byteLength > maxBytes) throw tooLarge();
    return bytes;
  }
  let cancellation;
  const cancel = () => {
    cancellation ??= cancelReadableBounded(reader);
    void cancellation.catch(() => {});
    return cancellation;
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge();
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  } catch (error) {
    await cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/**
 * Return the existing promise for a cache key, or create one and remove it
 * only when that exact promise settles.
 */
export function coalesceProxyRequest(inFlight, key, create) {
  const existing = inFlight.get(key);
  if (existing) return { promise: existing, shared: true };
  let promise;
  promise = Promise.resolve()
    .then(create)
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return { promise, shared: false };
}
