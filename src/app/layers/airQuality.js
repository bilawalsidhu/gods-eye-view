import { createAirQualityLayer } from '../../layers/airQuality/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire air-quality readings to the application overlay host. */
export function createApplicationAirQuality(options) {
  return createAirQualityLayer({
    overlayHost,
    canManageConnection: () =>
      Boolean(globalThis.document?.getElementById('key-setup')),
    onManageConnection: () =>
      globalThis.document?.dispatchEvent(
        new CustomEvent('gev:connection-setup', {
          detail: { providerId: 'data-gov-in' },
        }),
      ),
    ...options,
  });
}
