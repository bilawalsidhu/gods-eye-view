/** Browser/stdio service for the local app's credential-owning WM bridge. */
import { readResponseJsonCapped } from '../sources/httpBody.js';
import { ToolError } from './catalog.js';

export function createWorldMonitorService({ fetchImpl }) {
  async function read(operation, query, signal) {
    const params = new URLSearchParams(query);
    const deadline = AbortSignal.timeout(30_000);
    const requestSignal = signal
      ? AbortSignal.any([signal, deadline])
      : deadline;
    let payload;
    try {
      const response = await fetchImpl(
        `/api/worldmonitor/${operation}?${params}`,
        { signal: requestSignal, redirect: 'error' },
      );
      payload = await readResponseJsonCapped(
        response,
        512 * 1024,
        requestSignal,
      );
      if (![200, 503].includes(response.status)) throw new Error();
    } catch {
      signal?.throwIfAborted();
      throw new ToolError(
        'unavailable',
        'The local World Monitor bridge did not answer',
      );
    }
    if (
      !payload ||
      !['complete', 'partial', 'stale', 'unavailable'].includes(payload.status)
    ) {
      throw new ToolError(
        'malformed',
        'The local World Monitor bridge returned invalid data',
      );
    }
    return payload;
  }
  return {
    getCountryHeadlines: (country, { signal } = {}) =>
      read('country-headlines', { country }, signal),
    getCountryBrief: (country, { signal } = {}) =>
      read('country-brief', { country }, signal),
    getFeedDigest: ({ variant = 'full', limit = 25, signal } = {}) =>
      read('feed-digest', { variant, limit: String(limit) }, signal),
  };
}
