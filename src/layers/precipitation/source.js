import {
  capabilitiesUrl,
  isServiceException,
  liveFrame,
  readFrame,
} from './model.js';

/**
 * Read each tier's current frame straight from its public WMS.
 *
 * No proxy: both services answer with `access-control-allow-origin: *`, carry
 * no key and impose no quota, so the server/providers pattern — which exists
 * for secrets, throttling and CORS repair — buys nothing here. The tier's own
 * origin is still pinned so a malformed table cannot redirect the request.
 */
export function createPrecipitationSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getFrame(tier, { signal } = {}) {
      const service = new URL(tier?.service ?? '');
      if (service.protocol !== 'https:' || service.origin !== tier.origin)
        throw new TypeError('A pinned HTTPS precipitation service is required');
      signal?.throwIfAborted();
      // Nothing to read: this service advertises no time and always serves now.
      if (tier.dated === false) return liveFrame();
      const response = await fetchImpl(capabilitiesUrl(tier), {
        method: 'GET',
        headers: { Accept: 'text/xml' },
        signal,
      });
      if (!response.ok)
        throw new Error(`${tier.label} HTTP ${response.status}`);
      const body = await response.text();
      // The body can resolve after the caller moved on; check before parsing.
      signal?.throwIfAborted();
      if (isServiceException(body))
        throw new Error(`${tier.label} returned a service exception`);
      return readFrame(body);
    },
  };
}
