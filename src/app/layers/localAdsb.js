import { createLocalAdsbLayer } from '../../layers/localAdsb/index.js';
import { createLocalReceiverFeeds } from '../../layers/localAdsb/feeds.js';
import { SdrController } from '../../sdr/controller.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import { markDetectionSourcesChanged } from '../../data/detection.js';
import { refreshTrackedReadout } from '../../data/trackedReadout.js';

/**
 * Construct the Local ADS-B layer, the browser RTL-SDR session it shares with
 * the Radio panel, and the decoder-feed session. Construction opens no device
 * and makes no request; the SDR starts only from an explicit Connect and the
 * feeds are polled only while the layer is enabled.
 */
export function createApplicationLocalAdsb({
  receiver = new SdrController(),
  feeds = createLocalReceiverFeeds(),
} = {}) {
  return createLocalAdsbLayer({
    receiver,
    feeds,
    services: {
      render,
      context,
      picking,
      detection: { markSourcesChanged: markDetectionSourcesChanged },
      overlays: { refreshReadout: refreshTrackedReadout },
    },
  });
}
