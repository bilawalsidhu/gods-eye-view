import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { validateTurbulenceSnapshot } from './records.js';

// Shared with tools: English data, translated where it is shown.
const msg = (text) => text;
const TURBULENCE_RESPONSE_LIMIT = 32 * 1024 * 1024;

/**
 * Lazy same-origin acquisition of the NOAA AWC turbulence snapshot. A cold
 * proxy refresh asks the upstream seven times in a row, so the deadline is
 * longer than a single-request source's.
 */
export function createTurbulenceSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 45_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error(msg('Turbulence request timed out'))),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl('/api/turbulence', {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Turbulence HTTP ${response.status}`);
        }
        const result = await readResponseJsonCapped(
          response,
          TURBULENCE_RESPONSE_LIMIT,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        return validateTurbulenceSnapshot(result);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
