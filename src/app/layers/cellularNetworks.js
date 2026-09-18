import { createCellularNetworksLayer } from '../../layers/cellular/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';

/** Wire cellular infrastructure to application-owned selection and render services. */
export function createApplicationCellularNetworks({ source }) {
  return createCellularNetworksLayer({
    source,
    services: { render, context, picking },
  });
}
