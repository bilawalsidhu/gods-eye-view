/**
 * Validates tool arguments against the JSON Schema subset tool definitions use:
 * object, array, string, number, integer and boolean types; required,
 * properties, additionalProperties, items, enum, minimum, maximum, minLength,
 * maxLength, pattern, minItems and maxItems. Unsupported keywords are rejected when a
 * tool is defined, so a schema can never promise checks that are not made.
 */

const KEYWORDS = new Set([
  'type',
  'description',
  'title',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'default',
]);
const TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
]);

/** Throw when a schema uses a keyword or type this validator does not check. */
export function assertSupportedSchema(schema, path = 'schema') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    throw new TypeError(`${path} must be an object`);
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key))
      throw new TypeError(`${path} uses unsupported keyword ${key}`);
  }
  if (!TYPES.has(schema.type))
    throw new TypeError(`${path} has unsupported type ${schema.type}`);
  if (schema.pattern !== undefined) new RegExp(schema.pattern, 'u');
  // Only the boolean form is checked; a schema here would go unenforced.
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== 'boolean'
  )
    throw new TypeError(`${path}.additionalProperties must be true or false`);
  for (const [name, child] of Object.entries(schema.properties || {}))
    assertSupportedSchema(child, `${path}.${name}`);
  if (schema.items) assertSupportedSchema(schema.items, `${path}[]`);
}

/**
 * Return a list of problems with a value, empty when it conforms. Messages
 * name the argument path so a model can correct its call.
 */
export function validateValue(schema, value, path = 'arguments') {
  const problems = [];
  const fail = (message) => problems.push(`${path} ${message}`);
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('must be an object');
        break;
      }
      for (const name of schema.required || []) {
        if (!Object.hasOwn(value, name) || value[name] === undefined)
          fail(`is missing ${name}`);
      }
      // Own properties only, so names such as constructor or __proto__ are
      // not mistaken for declared ones.
      const properties = schema.properties || {};
      for (const [name, child] of Object.entries(value)) {
        if (Object.hasOwn(properties, name))
          problems.push(
            ...validateValue(properties[name], child, `${path}.${name}`),
          );
        else if (schema.additionalProperties === false)
          fail(`has unknown property ${name}`);
      }
      break;
    }
    case 'array':
      if (!Array.isArray(value)) {
        fail('must be an array');
        break;
      }
      if (schema.minItems != null && value.length < schema.minItems)
        fail(`must have at least ${schema.minItems} items`);
      if (schema.maxItems != null && value.length > schema.maxItems)
        fail(`must have at most ${schema.maxItems} items`);
      if (schema.items)
        value.forEach((item, index) =>
          problems.push(
            ...validateValue(schema.items, item, `${path}[${index}]`),
          ),
        );
      break;
    case 'string':
      if (typeof value !== 'string') {
        fail('must be a string');
        break;
      }
      if (schema.minLength != null && value.length < schema.minLength)
        fail(`must be at least ${schema.minLength} characters`);
      if (schema.maxLength != null && value.length > schema.maxLength)
        fail(`must be at most ${schema.maxLength} characters`);
      if (
        schema.pattern !== undefined &&
        !new RegExp(schema.pattern, 'u').test(value)
      )
        fail(`must match ${schema.pattern}`);
      break;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail('must be a number');
        break;
      }
      if (schema.type === 'integer' && !Number.isInteger(value))
        fail('must be an integer');
      if (schema.minimum != null && value < schema.minimum)
        fail(`must be at least ${schema.minimum}`);
      if (schema.maximum != null && value > schema.maximum)
        fail(`must be at most ${schema.maximum}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail('must be true or false');
      break;
  }
  if (schema.enum && !schema.enum.includes(value))
    fail(
      `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`,
    );
  return problems;
}
