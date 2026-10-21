import {
  createReceiverPositionSource,
  createReceptionHorizonLayer,
} from '../../layers/receptionHorizon/index.js';
import * as render from '../../renderGovernor.js';
import * as input from '../../data/inputOwnership.js';
import * as scenePick from '../../data/scenePick.js';

/**
 * Construct the Reception Horizon layer over the application's Local ADS-B
 * layer. Construction makes no request; the antenna position route is read
 * only while the layer is on.
 */
export function createApplicationReceptionHorizon({
  localAdsb,
  positions = createReceiverPositionSource(),
} = {}) {
  return createReceptionHorizonLayer({
    localAdsb,
    positions,
    services: { render, input, scenePick },
  });
}
