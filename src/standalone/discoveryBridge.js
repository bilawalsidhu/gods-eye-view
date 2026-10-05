import { observedArea } from './investigationBridge.js';
import { getSelectedEntityContext } from '../data/contextStore.js';

/** Expose only public position, explicit navigation and current aircraft type. */
export function createDiscoveryBridge(application) {
  return {
    getArea: () => observedArea(application, 10),
    getSelectedType: () => {
      const components = application.getComponents();
      const record = getSelectedEntityContext({
        dataManager: components.data?.dataManager,
      });
      return ['flights', 'military'].includes(record?.layerId)
        ? (record.properties?.type ?? null)
        : null;
    },
    async navigate(card) {
      if (card.body !== 'earth' || !card.coordinate)
        throw new Error('Only Earth navigation is available.');
      const runner = application.getComponents().tools?.voiceCommands?.runner;
      if (!runner) throw new Error('Globe is not ready.');
      const result = await runner('fly_to_location', {
        latitude: card.coordinate.lat,
        longitude: card.coordinate.lon,
        viewMode: 'overview',
        rangeM: 5000,
      });
      if (result?.ok === false) throw new Error('Navigation failed.');
      return result;
    },
  };
}
