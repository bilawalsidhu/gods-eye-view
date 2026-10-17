/**
 * The MCP Apps globe panel for MCP servers that compose Core's tools: the
 * panel resource and the script its page runs. A server serves the panel
 * build at PANEL_BASE and passes the same key to the resource and to the
 * tool services (see src/tools/services.js).
 */
export {
  GLOBE_PANEL_URI,
  PANEL_BASE,
  createGlobePanelResource,
} from './globePanel.js';
export { panelRuntime } from '../app/globePanelRuntime.js';
