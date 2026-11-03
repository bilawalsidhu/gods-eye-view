import { createAirQualityLayer } from '../../layers/airQuality/index.js';
import { overlayHost } from './overlayHost.js';
import { useProviderSettingsStore } from '../../ui/stores/providerSettings.js';
import { applicationPinia } from '../../ui/vueRuntime.js';
/** Wire air-quality readings to the application overlay host. */
export function createApplicationAirQuality(options) {
  return createAirQualityLayer({
    overlayHost,
    canManageConnection: () => {
      const store = useProviderSettingsStore(applicationPinia());
      return Boolean(store.view?.ready && store.controls);
    },
    onManageConnection: () =>
      useProviderSettingsStore(applicationPinia()).controls?.open(
        'data-gov-in',
      ),
    ...options,
  });
}
