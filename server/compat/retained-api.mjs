import { retainedApiPlugins } from '../../vite.config.js';
import { createConnectCompatibilityBridge } from './connect-adapter.mjs';

export const RETAINED_CONTRACT_IDS = Object.freeze([
  'celestrak',
  'tomtom-status',
  'tomtom-flow',
  'firms',
  'firms-status',
  'terrain-heights',
  'adsbdb',
  'overpass',
  'route',
  'opensky',
  'opensky-track',
  'adsblol-military',
  'adsblol-trace',
  'cctv',
  'military-installations',
  'regional-brief',
  'weather-effects',
]);

export function createCompatibilityBridge(config) {
  return createConnectCompatibilityBridge({
    plugins: retainedApiPlugins(),
    responseLimitBytes: config.responseLimitBytes,
    contractIds: RETAINED_CONTRACT_IDS,
  });
}
