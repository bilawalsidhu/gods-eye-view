import { createLocalAdsbLayer } from '../../layers/localAdsb/index.js';
import { SdrController } from '../../sdr/controller.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import { markDetectionSourcesChanged } from '../../data/detection.js';
import { refreshTrackedReadout } from '../../data/trackedReadout.js';

/**
 * Construct the Local ADS-B layer and the browser RTL-SDR session it shares
 * with the Radio panel. Construction opens no device; the session starts only
 * from an explicit Connect.
 */
export function createApplicationLocalAdsb({
  receiver = new SdrController(),
} = {}) {
  return createLocalAdsbLayer({
    receiver,
    services: {
      render,
      context,
      picking,
      detection: { markSourcesChanged: markDetectionSourcesChanged },
      overlays: { refreshReadout: refreshTrackedReadout },
    },
  });
}
