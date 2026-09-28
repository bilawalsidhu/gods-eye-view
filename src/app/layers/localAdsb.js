import { createLocalAdsbLayer } from '../../layers/localAdsb/index.js';
import { createLocalReceiverFeeds } from '../../layers/localAdsb/feeds.js';
import { SdrController } from '../../sdr/controller.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import * as trails from '../../data/trailRenderer.js';
import * as geoid from '../../data/geoid.js';
import { markDetectionSourcesChanged } from '../../data/detection.js';
import { refreshTrackedReadout } from '../../data/trackedReadout.js';

/**
 * Construct the Local ADS-B layer, the browser RTL-SDR session it shares with
 * the Radio panel, and the decoder-feed session. Construction opens no device
 * and makes no request; the SDR starts only from an explicit Connect and the
 * feeds are polled only while the layer is enabled.
 *
 * `displayParams` reads the public Flights layer's DISPLAY-rail 3D preference
 * (`{ models3d, models3dMode }`) so local aircraft follow the same toggle;
 * `enrichment` is the Flights source whose cached adsbdb proxy they share.
 */
export function createApplicationLocalAdsb({
  receiver = new SdrController(),
  feeds = createLocalReceiverFeeds(),
  surface = null,
  enrichment = null,
  displayParams = null,
  resolveAsset = (url) =>
    `${import.meta.env?.BASE_URL || '/'}${url.replace(/^\//, '')}`,
} = {}) {
  return createLocalAdsbLayer({
    receiver,
    feeds,
    resolveAsset,
    services: {
      render,
      context,
      picking,
      trails,
      geoid,
      groundSnap: surface?.groundSnap || null,
      enrichment,
      display: displayParams ? { getParams: displayParams } : null,
      detection: { markSourcesChanged: markDetectionSourcesChanged },
      overlays: { refreshReadout: refreshTrackedReadout },
    },
  });
}
