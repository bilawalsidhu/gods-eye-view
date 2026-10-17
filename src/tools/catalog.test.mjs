import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, defineTool, ToolError } from './catalog.js';
import { validateValue } from './schema.js';

const echo = (name, extra = {}) =>
  defineTool({
    name,
    title: `Echo ${name}`,
    description: 'Returns its arguments.',
    inputSchema: {
      type: 'object',
      properties: { word: { type: 'string', maxLength: 5 } },
      additionalProperties: false,
    },
    run: async (args) => ({ summary: name, data: { args } }),
    ...extra,
  });

test('definitions are validated, frozen and read-only by default', () => {
  const tool = echo('echo');
  assert.equal(Object.isFrozen(tool), true);
  assert.equal(tool.kind, 'query');
  assert.deepEqual(tool.annotations, { readOnlyHint: true });
  assert.equal(echo('act', { kind: 'action' }).annotations.readOnlyHint, false);
  assert.throws(() => echo('Bad-Name'), /Invalid tool name/);
  assert.throws(() => echo('x', { kind: 'other' }), /Invalid tool kind/);
  assert.throws(() => echo('x', { title: '' }), /needs a title/);
  assert.throws(
    () =>
      echo('x', {
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'string', format: 'email' } },
        },
      }),
    /unsupported keyword format/,
  );
  assert.throws(
    () => echo('x', { inputSchema: { type: 'string' } }),
    /must describe an object/,
  );
});

test('composition rejects duplicates unless replaced, and hides tools without services', () => {
  const first = echo('echo');
  const second = echo('echo', { description: 'Replacement.' });
  assert.throws(
    () => composeCatalog({ tools: [first, second] }),
    /Duplicate tool name: echo/,
  );
  assert.throws(
    () => composeCatalog({ tools: [first], replace: ['other'] }),
    /Cannot replace unknown tool/,
  );
  const replaced = composeCatalog({
    tools: [first, second],
    replace: ['echo'],
  });
  assert.equal(replaced.get('echo').description, 'Replacement.');

  const needsFeed = echo('feed', { requires: ['feed'] });
  assert.deepEqual(
    composeCatalog({ tools: [first, needsFeed] })
      .list()
      .map((tool) => tool.name),
    ['echo'],
  );
  assert.deepEqual(
    composeCatalog({ tools: [first, needsFeed], services: { feed: {} } })
      .list()
      .map((tool) => tool.name),
    ['echo', 'feed'],
  );
});

test('calls validate arguments and pass through interceptors outermost first', async () => {
  const order = [];
  const catalog = composeCatalog({
    tools: [echo('echo')],
    interceptors: [
      async (call, next) => {
        order.push(`outer:${call.tool.name}`);
        const result = await next(call);
        order.push('outer:done');
        return result;
      },
      (call, next) => {
        order.push('inner');
        return next({ ...call, args: { word: 'hi' } });
      },
    ],
  });
  const result = await catalog.call('echo', { word: 'ignored' });
  assert.deepEqual(result, { summary: 'echo', data: { args: { word: 'hi' } } });
  assert.deepEqual(order, ['outer:echo', 'inner', 'outer:done']);

  await assert.rejects(
    composeCatalog({ tools: [echo('echo')] }).call('echo', {
      word: 'toolong',
      extra: 1,
    }),
    (error) =>
      error instanceof ToolError &&
      error.code === 'invalid_arguments' &&
      /arguments\.word must be at most 5 characters/.test(error.message) &&
      /unknown property extra/.test(error.message),
  );
  await assert.rejects(
    composeCatalog({ tools: [] }).call('missing'),
    (error) => error.code === 'unsupported',
  );
});

test('a tool that returns no summary is a programming error, not a tool error', async () => {
  const broken = echo('broken', { run: async () => ({ data: {} }) });
  await assert.rejects(
    composeCatalog({ tools: [broken] }).call('broken'),
    (error) => error instanceof TypeError && !(error instanceof ToolError),
  );
});

test('tool errors only use known codes', () => {
  assert.throws(() => new ToolError('nope', 'x'), /Unknown tool error code/);
  assert.equal(
    new ToolError('retry_later', 'x', { retryAfterSeconds: 5 })
      .retryAfterSeconds,
    5,
  );
});

test('only live source errors are translated', async () => {
  const { fromSourceError } = await import('./catalog.js');
  const plain = new Error('x');
  assert.equal(fromSourceError(plain), plain);
  const denied = Object.assign(new Error('refused'), {
    name: 'LiveSourceError',
    code: 'denied',
  });
  const translated = fromSourceError(denied);
  assert.equal(translated.code, 'unavailable');
  assert.equal(translated.retryAfterSeconds, null);
  const odd = Object.assign(new Error('?'), {
    name: 'LiveSourceError',
    code: 'toString',
  });
  assert.equal(fromSourceError(odd), odd);
});

test('patterns are validated and must compile', () => {
  const schema = {
    type: 'object',
    properties: { id: { type: 'string', pattern: '^[a-f]{2}$' } },
  };
  assert.deepEqual(validateValue(schema, { id: 'ab' }), []);
  assert.deepEqual(validateValue(schema, { id: 'xy' }), [
    'arguments.id must match ^[a-f]{2}$',
  ]);
  assert.throws(
    () =>
      echo('x', {
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', pattern: '(' } },
        },
      }),
    SyntaxError,
  );
});

test('the validator checks every supported keyword', () => {
  const schema = {
    type: 'object',
    required: ['n'],
    properties: {
      n: { type: 'integer', minimum: 1, maximum: 3 },
      list: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: { type: 'number' },
      },
      mode: { type: 'string', enum: ['a', 'b'] },
      flag: { type: 'boolean' },
    },
  };
  assert.deepEqual(
    validateValue(schema, { n: 2, list: [1], mode: 'a', flag: true }),
    [],
  );
  assert.deepEqual(
    validateValue(schema, { n: 1.5, list: [], mode: 'c', flag: 'yes' }),
    [
      'arguments.n must be an integer',
      'arguments.list must have at least 1 items',
      'arguments.mode must be one of "a", "b"',
      'arguments.flag must be true or false',
    ],
  );
  assert.deepEqual(validateValue(schema, {}), ['arguments is missing n']);
  assert.deepEqual(validateValue(schema, []), ['arguments must be an object']);
  assert.deepEqual(validateValue(schema, { n: Number.NaN }), [
    'arguments.n must be a number',
  ]);
});

test('inherited names are not declared properties, and schema-valued additionalProperties is refused', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' } },
    additionalProperties: false,
  };
  for (const name of ['constructor', 'toString', '__proto__'])
    assert.deepEqual(validateValue(schema, JSON.parse(`{"${name}": 1}`)), [
      `arguments has unknown property ${name}`,
    ]);
  assert.deepEqual(validateValue({ ...schema, required: ['toString'] }, {}), [
    'arguments is missing toString',
  ]);
  assert.throws(
    () =>
      defineTool({
        name: 'loose',
        title: 'Loose',
        description: 'Promises checks it cannot make.',
        inputSchema: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        run: async () => ({ summary: '', data: {} }),
      }),
    /additionalProperties must be true or false/,
  );
});
