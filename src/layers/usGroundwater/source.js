import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { validateWellPack, WELL_LIMITS } from './pack.js';

/** Load one caller-owned same-origin snapshot. No USGS calls, keys or polling. */
export function createWellPackSource({
  url,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  validatePack = validateWellPack,
} = {}) {
  if (
    typeof url !== 'string' ||
    !url.startsWith('/') ||
    url.startsWith('//') ||
    url.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(url)
  )
    throw new TypeError('Well pack requires a same-origin absolute path');
  // Resolve against the page origin, not document.baseURI. Fetching the admitted
  // absolute URL also prevents a cross-origin <base> from changing the target.
  const base = new URL(globalThis.location?.origin ?? 'https://gev.invalid');
  const target = new URL(url, base);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    target.origin !== base.origin
  )
    throw new TypeError('Well pack requires a same-origin absolute path');
  return {
    async getSnapshot({ signal } = {}) {
      const deadline = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      combined.throwIfAborted();
      const response = await fetchImpl(target.href, {
        signal: combined,
        credentials: 'omit',
        redirect: 'error',
      });
      if (!response.ok)
        throw new Error(`Well pack unavailable (HTTP ${response.status})`);
      const pack = await readResponseJsonCapped(
        response,
        WELL_LIMITS.bytes,
        combined,
      );
      combined.throwIfAborted();
      return validatePack(pack);
    },
  };
}
