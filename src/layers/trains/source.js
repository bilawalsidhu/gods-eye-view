import { TRAINS_API_URL } from './policy.js';
import { normalizeTrainsPayload } from './records.js';

/** Request and validate a complete live-train snapshot before it can replace
 * the displayed fleet. The API is keyless and CORS-open, so the browser
 * fetches it directly — no proxy route and no credential to broker. */
export function createAmtrakerTrainSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiUrl = TRAINS_API_URL,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(apiUrl, { signal });
      if (!response.ok) throw new Error(`Amtraker HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeTrainsPayload(payload);
      if (!rows) throw new Error('Malformed Amtraker response');
      return rows;
    },
    label: 'Amtrak · Amtraker community API',
    attribution: {
      name: 'Amtraker',
      description: 'Amtrak live positions via the Amtraker community API',
      text: 'Amtrak positions via Amtraker',
      href: 'https://amtraker.com',
    },
  };
}
