/**
 * Read a fetch() Response body as text with a hard byte cap. Rejects early on an
 * oversized Content-Length, then streams with a running cap so a chunked or
 * length-omitted response cannot blow past the limit. Throws { code:'RESPONSE_TOO_LARGE' }.
 */
export async function readResponseTextCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const err = new Error('Upstream response too large');
    err.code = 'RESPONSE_TOO_LARGE';
    throw err;
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      const err = new Error('Upstream response too large');
      err.code = 'RESPONSE_TOO_LARGE';
      throw err;
    }
    return text;
  }
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* no-op */
      }
      const err = new Error('Upstream response too large');
      err.code = 'RESPONSE_TOO_LARGE';
      throw err;
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** Parse a fetch() JSON response only after enforcing a hard byte cap. */
export async function readResponseJsonCapped(response, maxBytes) {
  return JSON.parse(await readResponseTextCapped(response, maxBytes));
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

/**
 * Read a fetch Response body as text while enforcing a hard byte cap during
 * the read — so a malicious or buggy upstream that streams an unbounded body
 * (no/oversized Content-Length, chunked) can't OOM the proxy. Returns
 * { tooLarge, text }. Cancels the stream as soon as the cap is crossed.
 * @param {Response} upstream - fetch() response.
 * @param {number} maxBytes - hard ceiling on decoded bytes.
 * @returns {Promise<{tooLarge: boolean, text: string}>}
 */
export async function readCappedResponseText(upstream, maxBytes) {
  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await upstream.body?.cancel();
    } catch {
      /* no-op */
    }
    return { tooLarge: true, text: '' };
  }
  if (
    !upstream.body ||
    typeof upstream.body[Symbol.asyncIterator] !== 'function'
  ) {
    const text = await upstream.text();
    return text.length > maxBytes
      ? { tooLarge: true, text: '' }
      : { tooLarge: false, text };
  }
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for await (const chunk of upstream.body) {
    total += chunk.length;
    if (total > maxBytes) {
      try {
        await upstream.body.cancel();
      } catch {
        /* no-op */
      }
      return { tooLarge: true, text: '' };
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return { tooLarge: false, text };
}
