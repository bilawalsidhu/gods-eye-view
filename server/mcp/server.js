/** The local MCP server: Core's tools over services backed by a running app. */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  composeCatalog,
  coreTools,
  catalogForSurface,
} from '../../src/tools/index.js';
import { panelRuntime } from '../../src/app/globePanelRuntime.js';
import { createGlobePanelResource } from '../../src/tools/globePanel.js';
import { createMcpServer } from '../../src/tools/mcp/index.js';
import { DEFAULT_API_BASE, createLocalToolServices } from './services.js';

const INSTRUCTIONS =
  "Tools answer questions from God's Eye View's live public data. Location " +
  'tools take an area: a place name, a bbox, or lat/lon with radius_km. ' +
  'Results are capped; check truncated and total before concluding there is nothing more. ' +
  "Answers that can be shown in God's Eye View include data.view; to show one, call " +
  'show_in_gods_eye_view with that view, adding layers, style, a camera or marks as ' +
  "needed. It shows live God's Eye View where the client displays apps and " +
  'returns a link everywhere.';

/** Construct the local MCP server for Core's tools. */
export function createLocalMcpServer({
  apiBase = DEFAULT_API_BASE,
  fetchImpl,
} = {}) {
  const { version } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  // Each server makes a new key for its panel. The panel's page carries it
  // and panel_request requires it; any client may read the page, so it keeps
  // the tool from clients that only list it, and is not access control.
  const panelKey = randomBytes(32).toString('base64url');
  return createMcpServer({
    catalog: catalogForSurface(
      composeCatalog({
        tools: coreTools,
        services: createLocalToolServices({ apiBase, fetchImpl, panelKey }),
      }),
      'mcp',
    ),
    name: 'gods-eye-view',
    version,
    instructions: INSTRUCTIONS,
    resources: [createGlobePanelResource({ runtime: panelRuntime, panelKey })],
  });
}
