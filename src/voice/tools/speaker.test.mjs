import assert from 'node:assert/strict';
import test from 'node:test';
import { schemas, createHandlers } from './speaker.js';
import { LOCAL_TOOL_PACKS } from './index.js';
import { LOCAL_TOOL_NAMES, isLocalTool } from '../localToolSchemas.js';

const NAMES = ['enroll_voice', 'who_is_speaking', 'forget_voice', 'list_voices'];

test('the speaker pack is registered and its schemas are well formed', () => {
  assert.ok(LOCAL_TOOL_PACKS.some((pack) => pack.schemas === schemas));
  assert.deepEqual(schemas.map((s) => s.name), NAMES);
  for (const schema of schemas) {
    assert.ok(schema.description.length > 20, schema.name);
    assert.equal(schema.parameters.type, 'object');
    assert.equal(schema.parameters.additionalProperties, false);
    assert.ok(LOCAL_TOOL_NAMES.includes(schema.name), `${schema.name} is a local tool`);
    assert.ok(isLocalTool(schema.name));
  }
  for (const name of ['enroll_voice', 'forget_voice'])
    assert.deepEqual(schemas.find((s) => s.name === name).parameters.required, ['name']);
  assert.equal(new Set(LOCAL_TOOL_NAMES).size, LOCAL_TOOL_NAMES.length, 'no duplicate tool names');
});

test('handlers call the speaker route with the matching op', async () => {
  const calls = [];
  const replies = {
    enroll: { ok: true, name: 'Anthony', added: 3, samples: 3, enrolled: 1 },
    identify: { ok: true, speaker: { name: 'Anthony', score: 0.81 }, candidates: [] },
    forget: { ok: true, name: 'Anthony', forgotten: true },
    list: { ok: true, count: 2, profiles: [{ name: 'Anthony' }, { name: 'Sarah' }] },
  };
  const handlers = createHandlers({
    fetchJson: async (url, body) => {
      calls.push([url, body]);
      return replies[body.op];
    },
  });
  assert.deepEqual(Object.keys(handlers), NAMES);
  const enrolled = await handlers.enroll_voice({ name: 'Anthony' });
  assert.equal(enrolled.ok, true);
  assert.match(enrolled.hint, /recognise Anthony/);
  assert.deepEqual(await handlers.who_is_speaking(), replies.identify);
  assert.deepEqual(await handlers.forget_voice({ name: 'Anthony' }), replies.forget);
  assert.deepEqual(await handlers.list_voices(), { ok: true, count: 2, names: ['Anthony', 'Sarah'] });
  assert.deepEqual(calls, [
    ['/api/voice/speaker', { op: 'enroll', name: 'Anthony' }],
    ['/api/voice/speaker', { op: 'identify' }],
    ['/api/voice/speaker', { op: 'forget', name: 'Anthony' }],
    ['/api/voice/speaker', { op: 'list' }],
  ]);
});

test('a failed enrollment comes back without a hint and route errors propagate', async () => {
  const handlers = createHandlers({
    fetchJson: async (_url, body) =>
      body.op === 'enroll' ? { ok: false, error: 'Nothing to enroll yet' } : Promise.reject(new Error('HTTP 503')),
  });
  assert.deepEqual(await handlers.enroll_voice({ name: 'Anthony' }), { ok: false, error: 'Nothing to enroll yet' });
  await assert.rejects(() => handlers.who_is_speaking(), /HTTP 503/);
});
