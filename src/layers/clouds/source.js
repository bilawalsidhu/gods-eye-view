/** Create the GOES cloud manifest source. */
export function createCloudsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal, product = 'GEOCOLOR' } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(
        '/api/goes/manifest?product=' + encodeURIComponent(product),
        {
          signal,
          cache: 'no-store',
        },
      );
      let payload;
      try {
        payload = await response.json();
      } catch {
        /* The HTTP status remains authoritative for error responses. */
      }
      signal?.throwIfAborted();
      if (!response.ok) throw new Error('Clouds HTTP ' + response.status);
      if (!Array.isArray(payload?.sources))
        throw new Error('Malformed cloud manifest');
      return payload;
    },
  };
}
