/**
 * The address the app's own paths (`/api/ion/`, `/api/mapillary/graph/`)
 * resolve against. In the MCP Apps panel that is the address the panel names
 * (`GEV_APP_BASE_URL`): the host serves the page from its own address, which
 * may not be usable as a base, and the panel answers requests under the named
 * address itself (see src/tools/globePanel.js). Otherwise it is the page's own
 * address; outside a page, a placeholder origin.
 * @returns {string}
 */
export const appBaseHref = () =>
  globalThis.GEV_APP_BASE_URL ??
  globalThis.location?.href ??
  'http://localhost/';
