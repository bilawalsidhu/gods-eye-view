import {
  cancelResponseBodyBounded,
  readResponseJsonCapped,
} from '../sources/httpBody.js';

const MAX_BYTES = 1024 * 1024;
const invalid = () => new Error('Invalid or incomplete model gateway stream.');

/** Read bounded gateway NDJSON; expose deltas but trust a completion only after EOF. */
export async function readLocalChatResponse(
  response,
  { signal, onDelta } = {},
) {
  if (
    !response.ok ||
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/x-ndjson')
  ) {
    const result = await readResponseJsonCapped(response, MAX_BYTES, signal);
    if (!response.ok)
      throw new Error(
        typeof result?.error === 'string'
          ? result.error
          : 'Model gateway request failed.',
      );
    return result;
  }
  if (
    Number(response.headers.get('content-length')) > MAX_BYTES ||
    signal?.aborted
  ) {
    await cancelResponseBodyBounded(response);
    signal?.throwIfAborted();
    throw invalid();
  }
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  let cancellation;
  const cancel = () => {
    cancellation ??= cancelResponseBodyBounded({ body: reader });
    void cancellation.catch(() => {});
    return cancellation;
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const readChunk = async () => {
    if (!signal) return reader.read();
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      signal.throwIfAborted();
      return await Promise.race([reader.read(), aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let pending = '';
  let complete = null;
  const consume = (line) => {
    if (!line.trim()) return;
    if (complete) throw invalid();
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw invalid();
    }
    if (!event || typeof event !== 'object' || Array.isArray(event))
      throw invalid();
    if (event.type === 'error')
      throw new Error(
        typeof event.error === 'string' && event.error
          ? event.error
          : 'Model gateway stream failed.',
      );
    if (event.type === 'delta') {
      if (typeof event.content !== 'string') throw invalid();
      onDelta?.(event);
    } else if (event.type === 'complete') {
      if (typeof event.content !== 'string' || !Array.isArray(event.toolCalls))
        throw invalid();
      complete = event;
    } else throw invalid();
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await readChunk();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw invalid();
      pending += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) consume(pending);
    if (!complete) throw invalid();
    return complete;
  } catch (error) {
    await cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
