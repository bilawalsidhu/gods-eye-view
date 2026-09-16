import { createLiveTrainsLayer } from '../../layers/trains/index.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
} from '../../renderGovernor.js';

/** Construct one live-trains layer wired to the application render governor. */
export function createApplicationTrains({ source }) {
  return createLiveTrainsLayer({
    source,
    services: {
      render: { holdContinuousRender, releaseContinuousRender },
    },
  });
}
