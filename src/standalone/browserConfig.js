import { requestWithDeadline } from '../sources/requestDeadline.js';
import { readResponseJsonCapped } from '../sources/httpBody.js';

const BROWSER_FIELDS = {
  googleApiKey: 'googleMapsApiKey',
  cesiumToken: 'cesiumIonToken',
  mapillaryToken: 'mapillaryClientToken',
};

/** Read optional same-origin configuration without preventing keyless/static startup. */
export async function readBrowserConfig(
  buildValues = {},
  { fetchImpl = globalThis.fetch, timeoutMs = 1000, signal } = {},
) {
  let runtime = {};
  try {
    const body = await requestWithDeadline(
      async (signal) => {
        const response = await fetchImpl('/api/runtime-config', {
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'error',
          signal,
        });
        if (!response.ok) return null;
        return readResponseJsonCapped(response, 16 * 1024, signal);
      },
      { timeoutMs, signal },
    );
    if (body && typeof body === 'object' && !Array.isArray(body))
      runtime = body;
  } catch {
    // Static hosts need no API endpoint; the existing build values still work.
  }
  return Object.fromEntries(
    Object.entries(BROWSER_FIELDS).map(([option, field]) => {
      const value = runtime[field];
      return [
        option,
        typeof value === 'string' && value.length > 0
          ? value
          : typeof buildValues[option] === 'string'
            ? buildValues[option]
            : '',
      ];
    }),
  );
}
