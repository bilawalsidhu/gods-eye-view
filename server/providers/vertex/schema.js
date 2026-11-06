// The fields of Vertex AI's OpenAPI-style Schema that a function declaration's
// `parameters` may carry. Any other JSON Schema keyword is left out, so the
// request never names a field Vertex does not know. The route still checks
// each call against the full JSON Schema (invalidCalls).
const VERTEX_SCHEMA_FIELDS = Object.freeze([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'default',
  'items',
  'minItems',
  'maxItems',
  'enum',
  'properties',
  'propertyOrdering',
  'required',
  'minProperties',
  'maxProperties',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
]);

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);

/** Convert one GEV JSON Schema to the Vertex Schema dialect, as a new object. */
export function toVertexSchema(jsonSchema) {
  if (!object(jsonSchema)) return {};
  const schema = {};
  for (const key of VERTEX_SCHEMA_FIELDS) {
    if (!Object.hasOwn(jsonSchema, key)) continue;
    const value = jsonSchema[key];
    if (key === 'properties') {
      if (!object(value)) continue;
      schema.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          toVertexSchema(child),
        ]),
      );
    } else if (key === 'items') {
      if (object(value)) schema.items = toVertexSchema(value);
    } else if (key === 'anyOf') {
      if (Array.isArray(value)) schema.anyOf = value.map(toVertexSchema);
    } else schema[key] = structuredClone(value);
  }
  // Vertex has no const; a single allowed value is a one-member enum.
  if (Object.hasOwn(jsonSchema, 'const') && !schema.enum)
    schema.enum = [structuredClone(jsonSchema.const)];
  // Vertex types are upper case, and a nullable type is a flag, not a union.
  const types = (
    Array.isArray(jsonSchema.type) ? jsonSchema.type : [jsonSchema.type]
  ).filter((type) => typeof type === 'string');
  const named = types.filter((type) => type !== 'null');
  if (named.length) schema.type = named[0].toUpperCase();
  else delete schema.type;
  if (types.includes('null')) schema.nullable = true;
  return schema;
}
