import { createActionTools } from '../../../src/voice/actionSchemas.js';
import { ACTION_DESCRIPTIONS } from './toolDescriptions.js';

export const GEV_REALTIME_TOOLS = createActionTools(ACTION_DESCRIPTIONS);

/**
 * The session's tools: the app actions, then additional function tools
 * whose names no action already uses.
 */
export function realtimeSessionTools(additional = []) {
  const names = new Set(GEV_REALTIME_TOOLS.map((tool) => tool.name));
  return [
    ...GEV_REALTIME_TOOLS,
    ...additional.filter((tool) => !names.has(tool.name)),
  ];
}
