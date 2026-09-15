/** Construct the registered-event fire archive endpoint without making a request. */
export function createFireHistorySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  baseUrl = '/api/fire-history',
} = {}) {
  async function readJson(url, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, { signal, cache: 'no-store' });
    let payload;
    try {
      payload = await response.json();
    } catch {
      /* status below remains authoritative */
    }
    signal?.throwIfAborted();
    return { response, payload };
  }
  return {
    /** Registered events, with or without a key. */
    async listEvents({ signal } = {}) {
      const { response, payload } = await readJson(baseUrl, signal);
      if (!response.ok) throw new Error(`Fire history HTTP ${response.status}`);
      if (!Array.isArray(payload?.events))
        throw new Error('Malformed fire history catalog');
      return { hasKey: Boolean(payload.hasKey), events: payload.events };
    },
    /** One event's archived detections, or `{keyRequired: true}` keyless. */
    async getEvent(id, { signal } = {}) {
      const safeId = encodeURIComponent(String(id || ''));
      if (!safeId) throw new Error('A fire event id is required');
      const { response, payload } = await readJson(
        `${baseUrl}/${safeId}`,
        signal,
      );
      if (!response.ok) {
        if (response.status === 503 && payload?.error === 'no_key')
          return { keyRequired: true };
        throw new Error(`Fire history HTTP ${response.status}`);
      }
      if (!Array.isArray(payload?.fires) || !payload?.event)
        throw new Error('Malformed fire history payload');
      return payload;
    },
  };
}
