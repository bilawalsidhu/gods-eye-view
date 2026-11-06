import test from 'node:test';
import assert from 'node:assert/strict';
import { toVertexSchema } from './schema.js';
import { GEV_REALTIME_TOOLS } from '../openai/tools.js';

const ALLOWED = new Set([
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
const TYPES = new Set([
  'STRING',
  'NUMBER',
  'INTEGER',
  'BOOLEAN',
  'ARRAY',
  'OBJECT',
]);

// Every schema node, with the JSON Schema node it came from.
function* pairs(source, converted, path) {
  yield [source, converted, path];
  for (const [name, child] of Object.entries(source.properties ?? {}))
    yield* pairs(child, converted.properties[name], `${path}.${name}`);
  if (source.items) yield* pairs(source.items, converted.items, `${path}[]`);
  for (const [index, child] of (source.anyOf ?? []).entries())
    yield* pairs(child, converted.anyOf[index], `${path}|${index}`);
}

test('real GEV tool schemas convert to keys Vertex accepts', () => {
  let constraints = 0;
  for (const tool of GEV_REALTIME_TOOLS) {
    const before = JSON.stringify(tool.parameters);
    const converted = toVertexSchema(tool.parameters);
    assert.equal(JSON.stringify(tool.parameters), before, 'never mutates');
    assert.equal(converted.type, 'OBJECT', tool.name);
    for (const [source, node, path] of pairs(
      tool.parameters,
      converted,
      tool.name,
    )) {
      for (const key of Object.keys(node))
        assert.ok(ALLOWED.has(key), `${path} keeps ${key}`);
      if (node.type !== undefined)
        assert.ok(TYPES.has(node.type), `${path} type ${node.type}`);
      assert.equal(node.type, source.type?.toUpperCase(), path);
      for (const key of ['required', 'enum', 'minimum', 'maximum']) {
        if (source[key] === undefined) continue;
        assert.deepEqual(node[key], source[key], `${path} keeps ${key}`);
        constraints++;
      }
      // The source constraints are copies, not shared references.
      if (source.enum) assert.notEqual(node.enum, source.enum);
    }
  }
  assert.ok(constraints > 100, 'the catalog carries constraints to keep');
});

test('unsupported JSON Schema keywords are dropped, const becomes enum', () => {
  assert.deepEqual(
    toVertexSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'x',
      type: 'object',
      additionalProperties: false,
      patternProperties: { '^x': { type: 'string' } },
      definitions: { a: { type: 'string' } },
      properties: {
        mode: { const: 'fast', type: 'string', examples: ['fast'] },
        label: { type: ['string', 'null'], default: null, maxLength: 8 },
        tags: {
          type: 'array',
          items: {
            type: 'string',
            format: 'date',
            additionalProperties: false,
          },
          minItems: 1,
        },
        either: {
          anyOf: [{ type: 'integer', minimum: 0 }, { type: 'boolean' }],
          oneOf: [{ type: 'string' }],
          allOf: [{ type: 'string' }],
        },
      },
      required: ['mode'],
    }),
    {
      type: 'OBJECT',
      properties: {
        mode: { type: 'STRING', enum: ['fast'] },
        label: { type: 'STRING', default: null, maxLength: 8, nullable: true },
        tags: {
          type: 'ARRAY',
          items: { type: 'STRING', format: 'date' },
          minItems: 1,
        },
        either: {
          anyOf: [{ type: 'INTEGER', minimum: 0 }, { type: 'BOOLEAN' }],
        },
      },
      required: ['mode'],
    },
  );
  assert.deepEqual(toVertexSchema(null), {});
});
