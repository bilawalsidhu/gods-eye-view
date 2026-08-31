/** Read a fetch response with a hard byte cap, including chunked responses. */
export async function readResponseTextCapped(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = new Error('Upstream response too large');
    error.code = 'RESPONSE_TOO_LARGE';
    throw error;
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      const error = new Error('Upstream response too large');
      error.code = 'RESPONSE_TOO_LARGE';
      throw error;
    }
    return text;
  }
  const decoder = new TextDecoder();
  let output = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* no-op */ }
      const error = new Error('Upstream response too large');
      error.code = 'RESPONSE_TOO_LARGE';
      throw error;
    }
    output += decoder.decode(value, { stream: true });
  }
  output += decoder.decode();
  return output;
}

export async function readResponseJsonCapped(response, maxBytes) {
  return JSON.parse(await readResponseTextCapped(response, maxBytes));
}

/** Share one in-flight refresh per cache key and release it when settled. */
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
