import { createLocalTelemetryLayer } from '../../layers/localTelemetry/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire industrial telemetry observations to the application overlay host. */
export function createApplicationLocalTelemetry(options) {
  return createLocalTelemetryLayer({ overlayHost, ...options });
}
