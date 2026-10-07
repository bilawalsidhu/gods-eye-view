/** Construct the existing live-fire endpoint without making a request. */
export function createFirmsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @param {{signal?: AbortSignal, etag?: ?string}} [options] - `etag` is
     *   the validator of a snapshot the caller already holds; the proxy then
     *   answers `{notModified: true}` instead of resending it.
     */
    async getSnapshot({ signal, etag } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/firms', {
        signal,
        cache: 'no-store',
        ...(etag ? { headers: { 'If-None-Match': etag } } : {}),
      });
      signal?.throwIfAborted();
      if (etag && response.status === 304) {
        // Read the empty body: an unread one is listed as net::ERR_ABORTED.
        await response.text?.();
        return { notModified: true };
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        /* status below remains authoritative */
      }
      signal?.throwIfAborted();
      if (!response.ok) {
        if (response.status === 503 && payload?.error === 'no_key')
          return { keyRequired: true };
        throw new Error(`FIRMS HTTP ${response.status}`);
      }
      if (!Array.isArray(payload?.fires))
        throw new Error('Malformed fire snapshot');
      payload.etag = response.headers?.get('etag') ?? null;
      return payload;
    },
  };
}
