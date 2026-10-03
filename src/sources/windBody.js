/** Read a fetch body under a hard byte budget, including chunked responses. */
export async function readWindBody(response, maxBytes, signal) {
  const fail = () => new Error('Wind response exceeds byte budget');
  if (Number(response.headers?.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw fail();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Wind response has no readable body');
  const chunks = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw fail();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
