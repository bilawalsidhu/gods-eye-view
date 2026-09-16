import { createMeshtasticLayer } from '../../layers/meshtastic/index.js';

export function createApplicationMeshtastic({ source }) {
  return createMeshtasticLayer({ source });
}
