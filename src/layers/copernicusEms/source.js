/**
 * Copernicus EMS activations, read through the server proxy.
 *
 * The browser NEVER names an upstream URL: it asks the local proxy for the
 * `active` route, and the proxy resolves the Copernicus activation API URL
 * from its own server-side allow-list.
 */
import { normalizeCopernicusActivations } from './model.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** The local proxy route that serves the ACTIVE activations. */
export const COPERNICUS_ACTIVATIONS_ENDPOINT = '/api/copernicus-ems/active';

/**
 * Construct the Copernicus EMS source.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Injected fetch, for tests.
 * @param {string} [options.endpoint] - The proxy route to read.
 * @returns {{getSnapshot: Function}}
 */
export function createCopernicusEmsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = COPERNICUS_ACTIVATIONS_ENDPOINT,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(endpoint, {
        signal,
        cache: 'no-store',
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        // The status below stays authoritative.
      }
      signal?.throwIfAborted();
      if (!response.ok) {
        throw new Error(`Copernicus EMS HTTP ${response.status}`);
      }
      const normalized = normalizeCopernicusActivations(payload);
      if (!normalized) throw new Error(msg('Malformed activation response'));
      return normalized;
    },
  };
}
