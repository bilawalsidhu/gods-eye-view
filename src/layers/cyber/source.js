import { readResponseJsonCapped } from '../../sources/httpBody.js';
import {
  normalizeCyberEnrichment,
  normalizeCyberKevSnapshot,
  normalizeCyberOtxResult,
  normalizeCyberSnapshot,
  normalizeShodanSearchResult,
} from './records.js';

const URLS = Object.freeze({
  'cloudflare-radar': '/api/cyber/radar',
  dshield: '/api/cyber/dshield',
  'cisa-kev': '/api/cyber/kev',
});
const ENRICHMENT_URLS = Object.freeze({
  shodanHost: '/api/cyber/enrich/shodan/host',
  shodanSearch: '/api/cyber/enrich/shodan/search',
  shodanArea: '/api/cyber/enrich/shodan/area',
  greynoise: '/api/cyber/enrich/greynoise/ip',
  otxLookup: '/api/cyber/otx/lookup',
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
        if (provider === 'cisa-kev')
          throw new Error(`CISA KEV catalog unavailable (${response.status}).`);
        throw new Error(`${provider} data unavailable (${response.status}).`);
      }
      const payload = await readResponseJsonCapped(
        response,
        provider === 'cisa-kev' ? 4 * 1024 * 1024 : 512 * 1024,
        controller.signal,
      );
      signal?.throwIfAborted();
      return provider === 'cisa-kev'
        ? normalizeCyberKevSnapshot(payload)
        : normalizeCyberSnapshot(payload, provider);
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
          invalid_area:
            'Zoom in to an area with a radius of 1,000 km or less, then try again.',
          invalid_indicator:
            'Enter a supported IOC: IP, domain, HTTP(S) URL, file hash, or CVE.',
        };
        if (url === ENRICHMENT_URLS.otxLookup) {
          const otxMessages = {
            missing_credentials:
              'Add your AlienVault OTX API key in Provider Settings.',
            invalid_credentials:
              'AlienVault OTX rejected the saved API key. Check it in Provider Settings.',
            rate_limited:
              'AlienVault OTX rate limit reached. Try the lookup again later.',
            upstream_timeout:
              'AlienVault OTX did not respond before the request timed out.',
            upstream_unavailable:
              'AlienVault OTX is temporarily unavailable. Try again later.',
            provider_response_too_large:
              'AlienVault OTX returned more data than the app can safely process.',
          };
          if (otxMessages[payload?.error])
            throw new Error(otxMessages[payload.error]);
          if (payload?.error === 'not_found')
            throw new Error('AlienVault OTX has no record for this indicator.');
          if (payload?.error === 'invalid_provider_data')
            throw new Error(
              'AlienVault OTX returned data the app could not read.',
            );
        }
        if (url.startsWith('/api/cyber/enrich/shodan/')) {
          if (Number.isInteger(payload?.providerStatus))
            throw new Error(
              `Shodan returned HTTP ${payload.providerStatus} for this request.`,
            );
          if (payload?.failureKind === 'upstream_timeout')
            throw new Error(
              'The Shodan request timed out before a response arrived.',
            );
          if (payload?.failureKind === 'upstream_network_error')
            throw new Error(
              `The app could not reach Shodan${
                typeof payload.transportCode === 'string' &&
                /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(payload.transportCode)
                  ? ` (${payload.transportCode})`
                  : ''
              }. Check the local network connection and try again.`,
            );
          if (payload?.failureKind === 'invalid_provider_data')
            throw new Error(
              'Shodan responded, but the app could not read its response.',
            );
          if (payload?.failureKind === 'provider_response_too_large')
            throw new Error(
              'Shodan returned more data than the app can safely process. The search has been narrowed; try again.',
            );
        }
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
    getKevSnapshot: (options) => get('cisa-kev', options),
    lookupShodanHost: async (ip, options) =>
      normalizeCyberEnrichment(
        await post(ENRICHMENT_URLS.shodanHost, { ip }, options),
        'shodan',
      ),
    searchShodan: async (query, page = 1, options) =>
      normalizeShodanSearchResult(
        await post(ENRICHMENT_URLS.shodanSearch, { query, page }, options),
      ),
    searchShodanArea: async ({ latitude, longitude, radiusKm }, options) =>
      normalizeShodanSearchResult(
        await post(
          ENRICHMENT_URLS.shodanArea,
          { latitude, longitude, radiusKm, query: options?.query || '' },
          options,
        ),
      ),
    lookupGreyNoise: async (ip, options) =>
      normalizeCyberEnrichment(
        await post(ENRICHMENT_URLS.greynoise, { ip }, options),
        'greynoise',
      ),
    lookupOtxIndicator: async (indicator, type = 'auto', options) =>
      normalizeCyberOtxResult(
        await post(ENRICHMENT_URLS.otxLookup, { indicator, type }, options),
      ),
  });
}
