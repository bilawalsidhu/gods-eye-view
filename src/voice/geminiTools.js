// Gemini function declarations accept an OpenAPI subset, not full JSON Schema.
const SCHEMA_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'anyOf',
  'title',
]);

/** Convert one JSON-Schema node to the Gemini Schema subset. */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(key)) continue;
    if (key === 'type') out.type = String(value).toUpperCase();
    else if (key === 'properties')
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          toGeminiSchema(child),
        ]),
      );
    else if (key === 'items') out.items = toGeminiSchema(value);
    else if (key === 'anyOf') out.anyOf = value.map(toGeminiSchema);
    else if (key === 'enum') {
      // Gemini enums are string-typed; numeric choices keep their bounds instead.
      if (value.every((entry) => typeof entry === 'string')) out.enum = value;
    } else out[key] = value;
  }
  if (out.type === 'OBJECT' && out.required && out.properties)
    out.required = out.required.filter((name) => name in out.properties);
  return out;
}

/** Map Realtime-style `{type:'function', name, description, parameters}` tools. */
export function toGeminiFunctionDeclarations(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...(tool.parameters ? { parameters: toGeminiSchema(tool.parameters) } : {}),
  }));
}

/** Gemini function responses must be objects. */
export function geminiFunctionResponse(result) {
  if (result && typeof result === 'object' && !Array.isArray(result))
    return result;
  return { result: result ?? null };
}
