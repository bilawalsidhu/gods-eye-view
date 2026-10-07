/**
 * Pure converters from the production Realtime tool list
 * (`{ type:'function', name, description, parameters }`) to other providers'
 * tool formats. Descriptions and schemas are carried over unchanged except
 * where a target cannot represent them; every such change is listed below.
 */

const PERMISSIVE_SCALAR = Object.freeze(['string', 'number', 'boolean']);

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Normalize a JSON schema for OpenAI-compatible local servers.
 *
 * Only one change: a property schema with no `type` (and no enum / anyOf /
 * oneOf / $ref / const that would imply one) gets a permissive scalar union.
 * `analyst_query.filters[].value` is `{}` in production — valid JSON Schema,
 * but chat templates that print `type` for every property (Gemma's among
 * them) crash on it.
 */
export function normalizeSchemaForChat(schema) {
  const out = clone(schema);
  const visit = (node, isRoot) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const implied = ['type', 'enum', 'anyOf', 'oneOf', 'allOf', '$ref', 'const'].some((k) => k in node);
    if (!isRoot && !implied) node.type = [...PERMISSIVE_SCALAR];
    if (node.properties) for (const sub of Object.values(node.properties)) visit(sub, false);
    if (node.items) visit(node.items, false);
    for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(node[key])) node[key].forEach((s) => visit(s, false));
  };
  visit(out, true);
  return out;
}

/**
 * Every schema location normalizeSchemaForChat changes, as
 * `{ tool, path, from, to }` — logged in summary.md so the per-provider
 * payload difference is explicit rather than implied.
 */
export function chatNormalizationDiff(realtimeTools) {
  const changes = [];
  const walk = (before, after, tool, where) => {
    if (!before || typeof before !== 'object' || Array.isArray(before)) return;
    if (JSON.stringify(before.type) !== JSON.stringify(after.type)) {
      changes.push({ tool, path: where, from: before.type === undefined ? '(untyped)' : before.type, to: after.type });
    }
    for (const [k, v] of Object.entries(before.properties || {})) walk(v, after.properties[k], tool, `${where}.${k}`);
    if (before.items) walk(before.items, after.items, tool, `${where}[]`);
  };
  for (const tool of realtimeTools) walk(tool.parameters, normalizeSchemaForChat(tool.parameters), tool.name, tool.name);
  return changes;
}

/** Realtime tools → Chat Completions tools (`{type:'function', function:{...}}`). */
export function toChatTools(realtimeTools, { normalize = true } = {}) {
  return realtimeTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalize ? normalizeSchemaForChat(tool.parameters) : clone(tool.parameters),
    },
  }));
}

// Keywords the Gemini OpenAPI-subset `Schema` does not accept.
const GEMINI_DROP = new Set(['additionalProperties', '$schema', 'default', 'examples', '$id', 'const']);

/**
 * Convert a JSON schema to the Gemini OpenAPI-subset `Schema`.
 * Drops unsupported keywords (additionalProperties, $schema, default, ...);
 * an untyped property becomes `anyOf` string|number|boolean; a type array
 * becomes `anyOf` of single types.
 */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (GEMINI_DROP.has(key)) continue;
    if (key === 'properties') {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]));
    } else if (key === 'items') {
      out.items = toGeminiSchema(value);
    } else if (key === 'anyOf' || key === 'oneOf') {
      out.anyOf = value.map((s) => toGeminiSchema(s));
    } else {
      out[key] = clone(value);
    }
  }
  if (Array.isArray(out.type)) {
    const types = out.type;
    delete out.type;
    out.anyOf = types.map((t) => ({ type: t }));
  }
  const implied = ['type', 'enum', 'anyOf'].some((k) => k in out);
  if (!implied) out.anyOf = PERMISSIVE_SCALAR.map((t) => ({ type: t }));
  return out;
}

/**
 * Realtime tools → Gemini `functionDeclarations`.
 *   mode 'jsonSchema' (default): pass the production schema verbatim through
 *     `parametersJsonSchema` — full JSON Schema, closest to prompt parity.
 *   mode 'openapi': convert to the OpenAPI-subset `parameters` field.
 * A tool with no properties gets no parameters field in openapi mode (Gemini
 * rejects an empty OBJECT schema there).
 */
export function toGeminiDeclarations(realtimeTools, { mode = 'jsonSchema' } = {}) {
  return realtimeTools.map((tool) => {
    const decl = { name: tool.name, description: tool.description };
    const params = tool.parameters;
    if (mode === 'jsonSchema') {
      decl.parametersJsonSchema = clone(params);
    } else if (params && Object.keys(params.properties || {}).length) {
      decl.parameters = toGeminiSchema(params);
    }
    return decl;
  });
}
