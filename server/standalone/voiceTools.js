/**
 * The voice session's tools for the standalone server: the app actions plus
 * the catalog tools voice offers (see src/tools/surfaces.js), which the
 * browser runs through the same catalog. World Monitor tools join only when
 * a local World Monitor backend is configured.
 */

import {
  coreTools,
  toFunctionTools,
  toolsForSurface,
} from '../../src/tools/index.js';
import {
  isWorldMonitorConfigured,
  worldMonitorTools,
} from '../../src/tools/queries/worldmonitor.js';
import { realtimeSessionTools } from '../providers/openai/tools.js';

export function standaloneVoiceTools({ env = process.env } = {}) {
  const tools = isWorldMonitorConfigured(env)
    ? [...coreTools, ...worldMonitorTools]
    : coreTools;
  return realtimeSessionTools(toFunctionTools(toolsForSurface(tools, 'voice')));
}
