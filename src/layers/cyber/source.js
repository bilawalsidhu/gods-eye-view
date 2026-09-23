import { readResponseJsonCapped } from '../../sources/httpBody.js';
import {
  normalizeCyberEnrichment,
  normalizeCyberSnapshot,
  normalizeShodanSearchResult,
} from './records.js';

const URLS = Object.freeze({
  'cloudflare-radar': '/api/cyber/radar',
  dshield: '/api/cyber/dshield',
});
const ENRICHMENT_URLS = Object.freeze({
  shodanHost: '/api/cyber/enrich/shodan/host',
  shodanSearch: '/api/cyber/enrich/shodan/search',
  greynoise: '/api/cyber/enrich/greynoise/ip',
});

/** Client for the same-origin, normalized Cyber provider endpoints. */
export function createCyberSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15_000,
} = {}) {
  async function get(provider, { signal } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(URLS[provider], {
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
      });
      if (!response.ok) {
        const payload = await readResponseJsonCapped(
          response,
          4096,
          controller.signal,
        ).catch(() => ({}));
        const code = String(payload?.error || '');
        if (code === 'missing_credentials')
          throw new Error(
            'Cloudflare Radar needs a token in Provider Settings.',
          );
        if (code === 'invalid_credentials')
          throw new Error('Cloudflare Radar credentials were rejected.');
        if (code === 'rate_limited')
          throw new Error(
            `${provider} is rate limited; cached data may be shown.`,
          );
        throw new Error(`${provider} data unavailable (${response.status}).`);
      }
      const payload = await readResponseJsonCapped(
        response,
        128 * 1024,
        controller.signal,
      );
      signal?.throwIfAborted();
      return normalizeCyberSnapshot(payload, provider);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  async function post(url, input, { signal } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
      });
      const payload = await readResponseJsonCapped(
        response,
        128 * 1024,
        controller.signal,
      ).catch(() => ({}));
      if (!response.ok) {
        const messages = {
          missing_credentials:
            'Add this provider’s API key in Provider Settings.',
          invalid_credentials: 'The provider rejected its saved credentials.',
          insufficient_credits:
            'Shodan reports that this account has no query credits for that request.',
          rate_limited: 'The provider rate limit was reached. Try again later.',
          invalid_ip: 'Enter a public IPv4 address.',
          invalid_query: 'Enter a supported Shodan search query.',
          invalid_page: 'That result page is unavailable.',
          not_found: 'The provider has no record for this IP.',
        };
        throw new Error(
          messages[payload?.error] ||
            `Provider request failed (${response.status}).`,
        );
      }
      signal?.throwIfAborted();
      return payload;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return Object.freeze({
    getRadarSnapshot: (options) => get('cloudflare-radar', options),
    getDshieldSnapshot: (options) => get('dshield', options),
    lookupShodanHost: async (ip, options) =>
      normalizeCyberEnrichment(
        await post(ENRICHMENT_URLS.shodanHost, { ip }, options),
        'shodan',
      ),
    searchShodan: async (query, page = 1, options) =>
      normalizeShodanSearchResult(
        await post(ENRICHMENT_URLS.shodanSearch, { query, page }, options),
      ),
    lookupGreyNoise: async (ip, options) =>
      normalizeCyberEnrichment(
        await post(ENRICHMENT_URLS.greynoise, { ip }, options),
        'greynoise',
      ),
  });
}
