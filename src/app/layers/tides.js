import { createTidesLayer } from '../../layers/tides/index.js';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../../renderGovernor.js';
/** Wire NOAA tide predictions to the application render governor. */
export function createApplicationTides(options) {
  return createTidesLayer({
    render: {
      governorRequestRender,
      holdContinuousRender,
      releaseContinuousRender,
    },
    ...options,
  });
}
