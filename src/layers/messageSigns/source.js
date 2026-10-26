import { msg } from '../../i18n/marker.js';
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
      const code =
        response.status === 503
          ? await response
              .json()
              .then((body) => body?.code)
              .catch(() => null)
          : null;
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      if (code === 'no-packs') {
        throw new Error(
          msg('No message-sign packs enabled; see .env.example to enable one'),
        );
      }
      throw new Error(
        response.status === 504
          ? msg('Message signs timed out')
          : msg('Message signs temporarily unavailable'),
      );
    }
    const payload = await response.json();
    signal?.throwIfAborted();
    if (!Array.isArray(payload?.signs)) {
      throw new Error(msg('Message signs returned an incomplete response'));
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
    label: msg('Message signs'),
    // No agency link here: the layer carries many packs, and each record
    // brings its own provider and licence for per-sign attribution.
    attribution: {
      name: 'Message signs',
      description: 'Agency traveler-information message signs (public)',
      text: 'Message signs',
    },
  };
}
