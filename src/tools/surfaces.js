/**
 * Which surfaces offer each tool. A tool is on every surface unless this
 * table turns it off; edit an entry to turn a tool on or off for MCP, voice,
 * or both. Applications can pass overrides when they compose a surface.
 * Tools off a surface stay reachable from tools that combine others, such as
 * situation_brief using get_weather.
 */

import { ToolError } from './catalog.js';

export const SURFACES = Object.freeze(['mcp', 'voice']);

const voiceOff = Object.freeze({ voice: false });
const mcpOff = Object.freeze({ mcp: false });

export const TOOL_SURFACES = Object.freeze({
  // Voice runs inside the app, so a link to it adds nothing.
  show_in_gods_eye_view: voiceOff,
  // Only the God's Eye View panel calls this, to load the app.
  panel_request: voiceOff,
  // Voice has an app action of the same name.
  next_satellite_pass: voiceOff,
  // Voice receives text only, so tools that answer with an image are off.
  get_weather_map: voiceOff,
  get_recent_imagery: voiceOff,
  get_cctv_snapshot: voiceOff,
  // The app shows its HUD caption itself, and assistants write their own.
  get_hud_caption: Object.freeze({ voice: false, mcp: false }),
  // Voice answers these from the loaded layers with analyst_query.
  aircraft_in_area: voiceOff,
  vessels_in_area: voiceOff,
  find_aircraft: voiceOff,
  find_vessel: voiceOff,
  get_earthquakes: voiceOff,
  get_active_fires: voiceOff,
  find_infrastructure: voiceOff,
  satellites_overhead: voiceOff,
  // MCP leads with what the globe shows; assistants already search places,
  // plan routes and report weather, and these layers add little in a chat.
  search_places: mcpOff,
  places_nearby: mcpOff,
  plan_route: mcpOff,
  get_weather: mcpOff,
  get_wind: mcpOff,
  get_regional_brief: mcpOff,
  find_radio_stations: mcpOff,
  get_bike_share: mcpOff,
  get_transit_vehicles: mcpOff,
});

/**
 * The tools a surface offers, in their original order. `overrides` uses the
 * table's shape and wins over it, such as `{ get_weather_map: { voice: true } }`.
 * An override naming an unknown tool or surface throws, so a typo cannot
 * silently do nothing.
 */
export function toolsForSurface(tools, surface, overrides = {}) {
  if (!SURFACES.includes(surface))
    throw new TypeError(`Unknown tool surface: ${surface}`);
  const names = new Set(tools.map((tool) => tool.name));
  for (const [name, entry] of Object.entries(overrides)) {
    if (!names.has(name)) throw new TypeError(`Unknown tool: ${name}`);
    for (const key of Object.keys(entry)) {
      if (!SURFACES.includes(key))
        throw new TypeError(`Unknown tool surface for ${name}: ${key}`);
    }
  }
  return tools.filter(
    (tool) =>
      (overrides[tool.name]?.[surface] ??
        TOOL_SURFACES[tool.name]?.[surface]) !== false,
  );
}

/**
 * A view of a composed catalog that lists and calls only the tools a surface
 * offers. Tools that combine others still reach the whole catalog, so a
 * composite such as military_awareness keeps its sections on every surface.
 */
export function catalogForSurface(catalog, surface, overrides = {}) {
  const offered = new Set(
    toolsForSurface(catalog.list(), surface, overrides).map(
      (tool) => tool.name,
    ),
  );
  return Object.freeze({
    list: () => catalog.list().filter((tool) => offered.has(tool.name)),
    get: (name) => (offered.has(name) ? catalog.get(name) : undefined),
    async call(name, args, options) {
      if (!offered.has(name))
        throw new ToolError(
          'unsupported',
          `No tool named ${name} is available`,
        );
      return catalog.call(name, args, options);
    },
  });
}
