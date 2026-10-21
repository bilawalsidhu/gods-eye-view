import test from 'node:test';
import assert from 'node:assert/strict';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { GEV_ACTION_SCHEMAS } from '../voice/actionSchemas.js';
import {
  describeValidationErrors,
  indexToolsByName,
  parseToolArguments,
  prepareToolCall,
  toChatCompletionTools,
  validateToolArguments,
} from '../../server/providers/agent/toolSchema.js';

const toolIndex = indexToolsByName(GEV_REALTIME_TOOLS);

test('every voice action reaches the chat surface with its schema intact', () => {
  const chat = toChatCompletionTools(GEV_REALTIME_TOOLS);
  assert.equal(chat.length, GEV_REALTIME_TOOLS.length);
  assert.ok(chat.length >= GEV_ACTION_SCHEMAS.length);
  for (const [index, tool] of chat.entries()) {
    const source = GEV_REALTIME_TOOLS[index];
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.name, source.name);
    assert.equal(tool.function.description, source.description ?? '');
    // The schema is reused by reference, so the two transports can never
    // disagree about what a tool accepts.
    assert.equal(tool.function.parameters, source.parameters);
  }
});

test('reshaping tolerates a missing schema and a non-array input', () => {
  assert.deepEqual(toChatCompletionTools(null), []);
  assert.deepEqual(toChatCompletionTools([{ name: '' }, null, 'x']), []);
  assert.deepEqual(toChatCompletionTools([{ name: 'bare' }]), [
    {
      type: 'function',
      function: {
        name: 'bare',
        description: '',
        parameters: { type: 'object', properties: {} },
      },
    },
  ]);
});

test('the index finds every named tool and nothing else', () => {
  assert.equal(toolIndex.size, GEV_REALTIME_TOOLS.length);
  assert.ok(toolIndex.has('fly_to_location'));
  assert.equal(toolIndex.get('no_such_tool'), undefined);
  assert.equal(indexToolsByName(null).size, 0);
});

test('arguments arrive as JSON, as an object, or as nothing at all', () => {
  assert.deepEqual(parseToolArguments('{"a":1}'), { ok: true, args: { a: 1 } });
  assert.deepEqual(parseToolArguments(''), { ok: true, args: {} });
  assert.deepEqual(parseToolArguments(undefined), { ok: true, args: {} });
  assert.deepEqual(parseToolArguments(null), { ok: true, args: {} });
  assert.deepEqual(parseToolArguments('   '), { ok: true, args: {} });
  assert.deepEqual(parseToolArguments({ a: 1 }), { ok: true, args: { a: 1 } });
});

test('a fenced JSON block is recovered rather than rejected', () => {
  assert.deepEqual(parseToolArguments('```json\n{"a":1}\n```'), {
    ok: true,
    args: { a: 1 },
  });
  assert.deepEqual(parseToolArguments('```\n{"a":1}\n```'), {
    ok: true,
    args: { a: 1 },
  });
});

test('a non-object payload is refused with what it actually was', () => {
  assert.match(parseToolArguments('[1,2]').error, /received array/);
  assert.match(parseToolArguments('"text"').error, /received string/);
  assert.match(parseToolArguments('null').error, /received null/);
  assert.match(parseToolArguments('{oops').error, /not valid JSON/);
  assert.match(parseToolArguments(7).error, /received number/);
  assert.match(parseToolArguments([1]).error, /received an array/);
});

test('validation covers the subset the action schemas use', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
      name: { type: 'string', maxLength: 4 },
      count: { type: 'integer', minimum: 1, maximum: 5 },
      mode: { enum: ['a', 'b'] },
      tags: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: { type: 'string' },
      },
    },
  };
  assert.equal(validateToolArguments(schema, { name: 'ok' }).valid, true);
  assert.deepEqual(validateToolArguments(schema, { name: 'toolong' }).errors, [
    { path: 'name', message: 'must be at most 4 characters' },
  ]);
  assert.deepEqual(validateToolArguments(schema, {}).errors, [
    { path: 'name', message: 'is required' },
  ]);
  assert.deepEqual(
    validateToolArguments(schema, { name: 'ok', extra: 1 }).errors,
    [{ path: 'extra', message: 'is not a recognized parameter' }],
  );
  assert.deepEqual(
    validateToolArguments(schema, { name: 'ok', count: 9 }).errors,
    [{ path: 'count', message: 'must be <= 5' }],
  );
  assert.deepEqual(
    validateToolArguments(schema, { name: 'ok', count: 1.5 }).errors,
    [{ path: 'count', message: 'expected integer, received number' }],
  );
  assert.deepEqual(
    validateToolArguments(schema, { name: 'ok', mode: 'c' }).errors,
    [{ path: 'mode', message: 'must be one of: a, b' }],
  );
  assert.deepEqual(
    validateToolArguments(schema, { name: 'ok', tags: [] }).errors,
    [{ path: 'tags', message: 'must have at least 1 items' }],
  );
  assert.deepEqual(
    validateToolArguments(schema, { name: 'ok', tags: ['a', 1] }).errors,
    [{ path: 'tags[1]', message: 'expected string, received number' }],
  );
  // No schema is not a reason to refuse a call.
  assert.equal(
    validateToolArguments(undefined, { anything: true }).valid,
    true,
  );
});

test('validation errors compact into something a model can act on', () => {
  const errors = Array.from({ length: 8 }, (_, index) => ({
    path: `f${index}`,
    message: 'is required',
  }));
  const described = describeValidationErrors(errors);
  assert.match(described, /^f0 is required;/);
  assert.match(described, /and 2 more$/);
  assert.equal(describeValidationErrors([]), '');
  assert.equal(describeValidationErrors(null), '');
  assert.equal(describeValidationErrors([{ path: '', message: 'bad' }]), 'bad');
});

test('a well-formed call against a real tool is prepared for the runner', () => {
  const style = toolIndex.get('set_visual_style');
  const [field] = Object.keys(style.parameters.properties);
  const value = style.parameters.properties[field].enum?.[0];
  const prepared = prepareToolCall(
    { name: 'set_visual_style', arguments: JSON.stringify({ [field]: value }) },
    toolIndex,
  );
  assert.deepEqual(prepared, {
    ok: true,
    name: 'set_visual_style',
    args: { [field]: value },
  });
});

test('a hallucinated tool name comes back as a correction, not a crash', () => {
  assert.deepEqual(
    prepareToolCall({ name: 'teleport', arguments: '{}' }, toolIndex),
    {
      ok: false,
      error: 'Unknown tool "teleport". Choose one of the provided tools.',
    },
  );
  assert.match(prepareToolCall({}, toolIndex).error, /missing a function name/);
  assert.match(prepareToolCall({ name: 'x' }, null).error, /Unknown tool/);
});

test('an invalid argument names the tool so the model can restate it', () => {
  const prepared = prepareToolCall(
    { name: 'set_visual_style', arguments: '{"nonsense":true}' },
    toolIndex,
  );
  assert.equal(prepared.ok, false);
  assert.match(prepared.error, /^Invalid arguments for set_visual_style: /);
  const malformed = prepareToolCall(
    { name: 'set_visual_style', arguments: '{oops' },
    toolIndex,
  );
  assert.match(malformed.error, /not valid JSON/);
});

test('a fence the model never closed is cheap to reject, not a stall', () => {
  // The pattern this replaced backtracked: 5,000 characters of whitespace
  // after an unterminated fence cost about 29 seconds on one core, and this
  // string is whatever the model put in `arguments`.
  const unterminated = `\`\`\`json${' '.repeat(50_000)}${'{'.repeat(10)}`;
  const started = process.hrtime.bigint();
  const parsed = parseToolArguments(unterminated);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(parsed.ok, false);
  assert.ok(
    elapsedMs < 250,
    `parsing an unterminated fence took ${elapsedMs.toFixed(0)}ms`,
  );
});

test('fenced arguments are unwrapped and unfenced ones left alone', () => {
  const expected = { ok: true, args: { a: 1 } };
  assert.deepEqual(parseToolArguments('{"a":1}'), expected);
  assert.deepEqual(parseToolArguments('```json\n{"a":1}\n```'), expected);
  assert.deepEqual(parseToolArguments('```\n{"a":1}\n```'), expected);
  assert.deepEqual(parseToolArguments('```json {"a":1} ```'), expected);
  assert.deepEqual(parseToolArguments('```json{"a":1}```'), expected);
  assert.deepEqual(parseToolArguments('``````'), { ok: true, args: {} });
  // A lone fence and trailing content past the close are not fenced blocks, so
  // the text is parsed as-is and fails as the malformed JSON it is.
  assert.equal(parseToolArguments('```').ok, false);
  assert.equal(parseToolArguments('```json\n{"a":1}\n```x').ok, false);
});
