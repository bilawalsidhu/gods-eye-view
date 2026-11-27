import { createApplicationVessels } from '../app/layers/aisLiveVessels.js';

import { createVesselSource } from '../sources/live/standalone.js';

const aisLiveVesselsLayer = createApplicationVessels({
  source: createVesselSource({
    apiUrl: import.meta.env?.VITE_AIS_LIVE_API_URL || '/api/vessels',
    // Resolved against the document's address, which a panel host may serve
    // from its own scheme.
    origin: () => globalThis.document?.baseURI ?? 'http://localhost',
  }),
  options: {
    maxRows: import.meta.env?.VITE_AIS_LIVE_MAX_ROWS,
    maxLabels: import.meta.env?.VITE_AIS_LIVE_LABEL_MAX_ROWS,
  },
});
export { AIS_FIRST_CONNECT_GRACE_MS } from '../layers/vessels/policy.js';
export default aisLiveVesselsLayer;
