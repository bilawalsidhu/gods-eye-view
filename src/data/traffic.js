import { createTrafficSource } from '../layers/traffic/source.js';
import { createTrafficLayer } from '../layers/traffic/index.js';
import * as credits from './dataCredits.js';
import * as render from '../renderGovernor.js';

const layer = createTrafficLayer({
  source: createTrafficSource(),
  services: { credits, render },
});
export const getTrafficTimingDiagnostics = layer.getTrafficTimingDiagnostics;
export const deriveTrafficFlowError = layer.deriveTrafficFlowError;
export const trafficFeedPresentation = layer.trafficFeedPresentation;
export default layer;
