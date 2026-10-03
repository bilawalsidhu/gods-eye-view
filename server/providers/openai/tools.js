import { createActionTools } from '../../../src/voice/actionSchemas.js';
import { ACTION_DESCRIPTIONS } from './toolDescriptions.js';

/** Every voice tool, as the Realtime session describes them. */
export const GEV_REALTIME_TOOLS = createActionTools(ACTION_DESCRIPTIONS);

/** Tools that need an operator-configured Overpass (OVERPASS_UPSTREAMS). */
export const OVERPASS_ONLY_TOOLS = Object.freeze(['osm_query']);

/**
 * The tools one session is offered. Bulk OpenStreetMap place search runs
 * only on an operator's Overpass, so without one `osm_query` is left out
 * rather than offered and refused.
 * @param {{overpass?: boolean}} [options]
 */
export function realtimeTools({ overpass = false } = {}) {
  return overpass
    ? GEV_REALTIME_TOOLS
    : GEV_REALTIME_TOOLS.filter(
        (tool) => !OVERPASS_ONLY_TOOLS.includes(tool.name),
      );
}
