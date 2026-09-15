import { TRANSIT_FEED_REGISTRY } from '../../data/transitFeeds.js';
import { ACTIVATION_ALTITUDE_M, TRANSIT_POLL_MS } from './policy.js';
import { transitStats } from './model.js';

export function createControls({ state: layerState, parts }) {
  const methods = {
    id: 'transit',
    name: 'Transit',
    icon: '🚌',
    source: 'GTFS-RT',
    updateInterval: TRANSIT_POLL_MS,

    getStats() {
      const feeds = [...layerState._activeFeeds.values()];
      return transitStats({
        enabled: layerState._enabled,
        count: layerState._vehicles.size,
        lastUpdate: layerState._lastUpdate,
        gateOpen: layerState._altitudeGateOpen,
        feeds,
        statuses: feeds.map((feed) => parts.ingestion.feedStatus(feed.id)),
        regions: TRANSIT_FEED_REGISTRY.length,
        activationKm: Math.round(ACTIVATION_ALTITUDE_M / 1000),
      });
    },

    /**
     * Keep a manager handle so proximity polls can repaint the panel row when
     * their data lands between ticks.
     * @param {object} dataManager DataLayerManager instance.
     */
    attachDataManager(dataManager) {
      layerState._dataManager = dataManager;
    },
  };
  return { methods };
}
