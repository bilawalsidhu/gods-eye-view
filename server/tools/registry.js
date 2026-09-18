/**
 * server/tools/registry.js — the catalogue of OnDemand-callable tools served by
 * `GET /api/tools/<name>` (server/serverless/tools-route.js) from the existing
 * catch-all function — NO new Vercel functions (count stays at 9).
 *
 * Each plugin module exports:
 *   plugin = { id, name, description, category, conversationStarters[] }
 *   tools  = [ { name, summary, description, params: <validateParams spec>,
 *                handler(params, ctx) → { ok, status?, data, provider?, provenance? } | failure } ]
 *
 * `params` uses the same whitelist spec language as server/sources/_shared.js
 * (`validateParams`), so unknown query parameters are a 400 `unknown_param`
 * everywhere, exactly like the Gate 3 earthquake adapter. `ctx` carries
 * { signal, env, now, requestUrl, tool }.
 *
 * The OpenAPI 3.0 documents under docs/plugins/<plugin>/openapi.json are
 * GENERATED from this registry by scripts/generate-tool-openapi.mjs — never
 * hand-edit them; edit the plugin module and regenerate.
 */
import * as satellites from './satellites.js';
import * as flights from './flights.js';
import * as military from './military.js';
import * as vessels from './vessels.js';
import * as traffic from './traffic.js';
import * as earthquakes from './earthquakes.js';

const MODULES = Object.freeze([
  satellites,
  flights,
  military,
  vessels,
  traffic,
  earthquakes,
]);

/** Every plugin descriptor with its tools, in stable registration order. */
export function listPlugins() {
  return MODULES.filter((m) => m?.plugin && Array.isArray(m.tools)).map(
    (m) => ({
      ...m.plugin,
      tools: m.tools.map((t) => ({ ...t })),
    }),
  );
}

/** Flat `{ name → tool }` map; a duplicate tool name is a programming error. */
export function toolIndex() {
  const index = new Map();
  for (const plugin of listPlugins()) {
    for (const tool of plugin.tools) {
      if (index.has(tool.name)) {
        throw new Error(
          `server/tools/registry.js: duplicate tool "${tool.name}"`,
        );
      }
      index.set(tool.name, { ...tool, plugin: plugin.id });
    }
  }
  return index;
}

/** Catalogue shape returned by `GET /api/tools` and injected into chat context. */
export function toolCatalogue() {
  return listPlugins().map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    category: plugin.category,
    conversationStarters: plugin.conversationStarters || [],
    tools: plugin.tools.map((tool) => ({
      name: tool.name,
      summary: tool.summary,
      path: `/api/tools/${tool.name}`,
      params: Object.fromEntries(
        Object.entries(tool.params || {}).map(([key, rule]) => [
          key,
          {
            type: rule.type,
            required: Boolean(rule.required),
            ...(rule.values ? { values: rule.values } : {}),
            ...(rule.min !== undefined ? { min: rule.min } : {}),
            ...(rule.max !== undefined ? { max: rule.max } : {}),
            ...(rule.default !== undefined ? { default: rule.default } : {}),
            ...(rule.description ? { description: rule.description } : {}),
          },
        ]),
      ),
    })),
  }));
}
