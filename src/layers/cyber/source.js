import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeCyberSnapshot } from './records.js';

const URLS = Object.freeze({
  'cloudflare-radar': '/api/cyber/radar',
  dshield: '/api/cyber/dshield',
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
  return Object.freeze({
    getRadarSnapshot: (options) => get('cloudflare-radar', options),
    getDshieldSnapshot: (options) => get('dshield', options),
  });
}
