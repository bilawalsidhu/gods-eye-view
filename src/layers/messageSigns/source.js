import { SIGNS_URL } from './policy.js';
import { normalizeSignRecord } from './model.js';

/**
 * Construct the sign request adapter without starting a request.
 *
 * Reads the app-origin route rather than any upstream directly; see
 * server/providers/messageSigns.js for why the proxy is required.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {{fetch:Function, label:string, attribution:object}}
 */
export function createMessageSignsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function fetchSigns(signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(SIGNS_URL, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      throw new Error(
        response.status === 504
          ? 'Message signs timed out'
          : 'Message signs temporarily unavailable',
      );
    }
    const payload = await response.json();
    signal?.throwIfAborted();
    if (!Array.isArray(payload?.signs)) {
      throw new Error('Message signs returned an incomplete response');
    }
    return {
      records: [
        ...new Map(
          payload.signs
            .map(normalizeSignRecord)
            .filter(Boolean)
            .map((record) => [record.id, record]),
        ).values(),
      ],
    };
  }
  return {
    fetch: fetchSigns,
    label: 'Message signs',
    // No agency link here: the layer carries many packs, and each record
    // brings its own provider and licence for per-sign attribution.
    attribution: {
      name: 'Message signs',
      description: 'Agency traveler-information message signs (public)',
      text: 'Message signs',
    },
  };
}
