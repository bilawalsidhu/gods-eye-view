import test from 'node:test';
import assert from 'node:assert/strict';
import { GEV_ACTION_SCHEMAS } from '../actionSchemas.js';
import {
  CORE_ACTIONS,
  LOCAL_ACTIONS,
  LOCAL_EXCLUDED_ACTIONS,
  MORE_ACTIONS_TOOL,
  buildLocalTools,
  coerceArguments,
  describeAction,
  describeMoreActions,
  normalizeSchema,
} from './toolset.js';
import {
  formatGemmaToolCall,
  parseGemmaToolCalls,
  stripGemmaMarkup,
} from './gemmaToolCalls.js';
import {
  actionReply,
  combineReplies,
  compactResultForModel,
  fallbackAnswer,
  needsSpokenAnswer,
  progressReply,
} from './replies.js';
import {
  createSentenceSplitter,
  normalizeForSpeech,
  spokenExcerpt,
} from './speechText.js';
import {
  LLM_MODELS,
  checkLocalVoiceSupport,
  findLlmModel,
  recommendLlmModel,
  storageAdvice,
} from './modelCatalog.js';
import { LOCAL_SYSTEM_PROMPT } from './localPrompt.js';

const ENGINE_KEYS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'items',
  'enum',
]);

function assertEngineSchema(schema, path = 'schema') {
  assert.ok(schema.type, `${path} has a type`);
  for (const key of Object.keys(schema))
    assert.ok(ENGINE_KEYS.has(key), `${path} drops ${key}`);
  for (const [key, child] of Object.entries(schema.properties || {}))
    assertEngineSchema(child, `${path}.${key}`);
  if (schema.items) assertEngineSchema(schema.items, `${path}[]`);
}

test('every action normalizes to the engine schema subset in both profiles', () => {
  for (const { name } of GEV_ACTION_SCHEMAS) {
    assertEngineSchema(
      describeAction(name, { profile: 'full' }).parameters,
      name,
    );
    assertEngineSchema(describeAction(name).parameters, name);
  }
});

test('untyped filter values become strings instead of breaking templates', () => {
  const value = normalizeSchema({ type: 'object', properties: { value: {} } });
  assert.equal(value.properties.value.type, 'string');
  const tool = describeAction('analyst_query', { profile: 'full' });
  assert.equal(
    tool.parameters.properties.filters.items.properties.value.type,
    'string',
  );
});

test('the local tool set declares every action it supports once', () => {
  const tools = buildLocalTools();
  assert.ok(tools.every((tool) => tool.type === 'function'));
  const names = tools.map((tool) => tool.function.name);
  assert.deepEqual(names, [...LOCAL_ACTIONS]);
  assert.deepEqual(
    GEV_ACTION_SCHEMAS.map((schema) => schema.name)
      .filter((name) => !names.includes(name))
      .sort(),
    [...LOCAL_EXCLUDED_ACTIONS].sort(),
  );
});

test('a hierarchical tool set adds one index for the remaining actions', () => {
  const tools = buildLocalTools({ core: CORE_ACTIONS });
  assert.equal(tools.length, CORE_ACTIONS.length + 1);
  const names = tools.map((tool) => tool.function.name);
  assert.deepEqual(names.slice(0, -1), [...CORE_ACTIONS]);
  assert.equal(names.at(-1), MORE_ACTIONS_TOOL);
  const indexed = describeMoreActions().parameters.properties.action.enum;
  assert.equal(indexed.length, LOCAL_ACTIONS.length - CORE_ACTIONS.length);
  assert.ok(indexed.includes('control_radio'));
  assert.ok(!indexed.includes('fly_to_location'));
});

test('compact projections keep a valid subset of the canonical arguments', () => {
  const annotate = describeAction('annotate_map').parameters;
  assert.deepEqual(Object.keys(annotate.properties), ['annotations', 'flyTo']);
  assert.deepEqual(
    Object.keys(annotate.properties.annotations.items.properties),
    ['type', 'target', 'label'],
  );
  assert.deepEqual(annotate.properties.annotations.items.required, ['type']);
  const fly = describeAction('fly_to_location').parameters;
  assert.deepEqual(Object.keys(fly.properties), ['query', 'rangeM']);
  assert.deepEqual(fly.required, ['query']);
  assert.match(
    describeAction('set_layer_visibility').parameters.properties.layerId
      .description,
    /local-firms/,
  );
});

test('the compact prompt stays small', () => {
  const chars =
    LOCAL_SYSTEM_PROMPT.length + JSON.stringify(buildLocalTools()).length;
  // The whole prefix is prefilled once per session and cloned per turn;
  // about four characters per token keeps it near 5k tokens.
  assert.ok(chars < 20000, `prompt is ${chars} chars`);
});

test('arguments are coerced toward the canonical schema', () => {
  assert.deepEqual(
    coerceArguments('set_layer_visibility', {
      layerId: 'Local_Firms',
      enabled: 'true',
      bogus: 1,
    }),
    { layerId: 'local-firms', enabled: true },
  );
  assert.deepEqual(
    coerceArguments('fly_to_location', { query: 'Tokyo', rangeM: '2,000' }),
    {
      query: 'Tokyo',
      rangeM: 2000,
    },
  );
  const query = coerceArguments('analyst_query', {
    layers: 'flights',
    filters: [{ field: 'altitudeM', op: 'gt', value: '12192' }],
  });
  assert.deepEqual(query.layers, ['flights']);
  assert.equal(query.filters[0].value, 12192);
  const identifiers = coerceArguments('analyst_query', {
    filters: [
      { field: 'icao24', op: 'eq', value: '001234' },
      { field: 'onGround', op: 'eq', value: 'false' },
      { field: 'mystery', op: 'eq', value: '42' },
      { field: 'callsign', op: 'eq', value: 123 },
    ],
  });
  assert.deepEqual(
    identifiers.filters.map((filter) => filter.value),
    ['001234', false, '42', '123'],
  );
  assert.deepEqual(
    normalizeSchema({ type: 'number', enum: [1, 2] }).enum,
    [1, 2],
  );
  assert.deepEqual(coerceArguments('zoom_to_globe', null), {});
});

test('Gemma tool calls parse from raw model text', () => {
  const args = {
    layerId: 'satellites',
    enabled: false,
    nested: { list: [1, 'two', true], text: 'a, b: c' },
  };
  const raw = `Sure.${formatGemmaToolCall('set_layer_visibility', args)}<|tool_response>`;
  const parsed = parseGemmaToolCalls(raw);
  assert.deepEqual(parsed.calls, [
    { name: 'set_layer_visibility', arguments: args },
  ]);
  assert.equal(parsed.text, 'Sure.');
  const two = parseGemmaToolCalls(
    '<|tool_call>call:zoom_to_globe{}<tool_call|><|tool_call>call:set_hud{visible:<|"|>off<|"|>}<tool_call|>',
  );
  assert.deepEqual(
    two.calls.map((call) => call.name),
    ['zoom_to_globe', 'set_hud'],
  );
  assert.deepEqual(two.calls[1].arguments, { visible: 'off' });
  assert.deepEqual(
    parseGemmaToolCalls('<|tool_call>call:stop_tracking<tool_call|>').calls,
    [{ name: 'stop_tracking', arguments: {} }],
  );
  assert.deepEqual(
    parseGemmaToolCalls('<|tool_call>call:x{a:<|"|>unterminated').calls,
    [],
  );
  assert.equal(
    stripGemmaMarkup('<|channel>thought\nhmm<channel|>Flights on.<turn|>'),
    'Flights on.',
  );
});

test('action replies confirm the resulting state tersely', () => {
  assert.equal(
    actionReply(
      'set_layer_visibility',
      { layerId: 'local-firms', enabled: true },
      { ok: true, layerId: 'local-firms', enabled: true },
    ),
    'Fires on.',
  );
  assert.equal(
    actionReply(
      'fly_to_location',
      { query: 'tokyo' },
      { ok: true, label: 'Tokyo, Japan' },
    ),
    'Flying to Tokyo.',
  );
  assert.equal(
    actionReply(
      'set_visual_style',
      { style: 'surveillance' },
      { ok: true, style: 'surveillance' },
    ),
    'Night vision.',
  );
  assert.equal(
    actionReply(
      'set_hud',
      { visible: 'off' },
      { ok: true, hud: { visible: false } },
    ),
    'HUD off.',
  );
  assert.equal(
    actionReply(
      'track_entity',
      { query: 'x' },
      { ok: false, error: 'Nothing matched "UAL999"' },
    ),
    'Nothing matched "UAL999".',
  );
  assert.equal(
    actionReply('zoom_to_globe', {}, { ok: false, cancelled: true }),
    null,
  );
  assert.equal(
    combineReplies(['HUD off.', null, 'Flying to Paris.']),
    'HUD off. Flying to Paris.',
  );
  assert.equal(
    actionReply(
      'set_map_stack',
      { stack: 'bing-aerial' },
      { ok: true, requested: 'bing-aerial' },
    ),
    'Bing aerial basemap.',
  );
  assert.equal(
    progressReply('set_layer_visibility', {
      layerId: 'local-firms',
      enabled: true,
    }),
    'Turning on fires.',
  );
  assert.equal(progressReply('set_hud', { visible: 'off' }), null);
  assert.equal(
    actionReply(
      'select_nearest_aircraft',
      {},
      { ok: true, label: 'SWA123', location: 'Austin, Texas' },
    ),
    'Selected SWA123 near Austin.',
  );
  assert.ok(needsSpokenAnswer('analyst_query'));
  assert.ok(!needsSpokenAnswer('set_hud'));
});

test('query fallbacks and model payloads stay short', () => {
  const result = {
    ok: true,
    action: 'analyst_query',
    count: 46,
    scopeLabel: 'flights over Texas',
    feedState: 'stale',
    items: Array.from({ length: 10 }, (_, index) => ({
      callsign: `AAL${index}`,
      altitudeM: 10000.123456,
    })),
    coverage: { big: true },
  };
  assert.equal(
    fallbackAnswer('analyst_query', result),
    '46 flights over Texas, stale. Top: AAL0.',
  );
  const compact = compactResultForModel(result);
  assert.equal(compact.items.length, 3);
  assert.equal(compact.items[0].altitudeM, 10000.12);
  assert.equal(compact.coverage, undefined);
  assert.equal(compact.action, undefined);
  const large = {
    ok: true,
    camera: { latitude: 30.123456, longitude: -97.5 },
    layers: Array.from({ length: 40 }, (_, index) => ({
      id: `layer-${index}`,
      detail: { nested: { deeper: 'x'.repeat(300) } },
    })),
  };
  const fitted = compactResultForModel(large, { budget: 400 });
  assert.ok(JSON.stringify(fitted).length <= 400);
  assert.equal(fitted.ok, true);
});

test('sentences stream out of partial model text', () => {
  const splitter = createSentenceSplitter({ minChars: 5 });
  assert.deepEqual(splitter.push('There are 46 flights'), []);
  assert.deepEqual(splitter.push(' in view. Dr. Smith is'), [
    'There are 46 flights in view.',
  ]);
  assert.deepEqual(splitter.push(' here! Done'), ['Dr. Smith is here!']);
  assert.deepEqual(splitter.flush(), ['Done']);
  assert.equal(spokenExcerpt('One. Two. Three.'), 'One. Two.');
});

test('speech text spells callsigns and drops markup', () => {
  assert.equal(
    normalizeForSpeech('**Tracking** UAL428 at 12 km'),
    'Tracking U A L four two eight at 12 kilometers',
  );
  assert.equal(normalizeForSpeech('<turn|>HUD off.'), 'HUD off.');
});

test('model support checks explain what is missing', () => {
  assert.equal(checkLocalVoiceSupport({ hasWebGpu: false }).ok, false);
  assert.match(checkLocalVoiceSupport({ hasWebGpu: false }).reason, /WebGPU/);
  assert.equal(
    checkLocalVoiceSupport({ hasWebGpu: true, adapter: false }).ok,
    false,
  );
  const big = findLlmModel('gemma-4-12b');
  assert.equal(
    checkLocalVoiceSupport({
      hasWebGpu: true,
      adapter: true,
      deviceMemoryGB: 8,
      model: big,
    }).ok,
    false,
  );
  assert.equal(
    checkLocalVoiceSupport({
      hasWebGpu: true,
      adapter: true,
      deviceMemoryGB: 32,
      model: big,
    }).ok,
    true,
  );
  assert.equal(recommendLlmModel({ deviceMemoryGB: 32 }).id, 'gemma-4-12b');
  assert.equal(recommendLlmModel({ deviceMemoryGB: 8 }).id, 'gemma-4-e4b');
  assert.ok(LLM_MODELS.every((model) => model.url.endsWith('-web.litertlm')));
});

test('storage advice warns only when a model cannot be kept', () => {
  const model = findLlmModel('gemma-4-12b');
  const speech = { label: 'Kokoro voice', bytes: 1e9 };
  assert.equal(storageAdvice({ quota: 20e9, usage: 3e9 }, [model]), null);
  assert.equal(storageAdvice({ quota: 20e9, usage: 17e9 }, []), null);
  assert.equal(storageAdvice(null, [model]), null);
  assert.equal(
    storageAdvice({ quota: 20e9, usage: 13.5e9 }, [model]),
    null,
    'the model alone fits',
  );
  assert.match(
    storageAdvice({ quota: 20e9, usage: 13.5e9 }, [model, speech]),
    /6\.5 GB free but Gemma 4 12B, Kokoro voice need 7\.0 GB/,
  );
  assert.match(
    storageAdvice({ quota: 20e9, usage: 0 }, [model], { persisted: false }),
    /may clear downloaded models/,
  );
  assert.equal(
    storageAdvice({ quota: 20e9, usage: 0 }, [], { persisted: false }),
    null,
  );
});

test('model downloads are pinned to a revision and a digest', () => {
  for (const model of LLM_MODELS) {
    assert.doesNotMatch(model.url, /\/resolve\/main\//);
    assert.match(model.url, /\/resolve\/[0-9a-f]{40}\//);
    assert.match(model.sha256, /^[0-9a-f]{64}$/);
  }
});

test('edge cases: JSON-quoted arguments, units, long sentences, device limits', () => {
  assert.deepEqual(
    parseGemmaToolCalls(
      '<|tool_call>call:track_entity{"query":"UAL \\"428\\"",<|"|>layerId<|"|>:<|"|>flights<|"|>}<tool_call|>',
    ).calls[0].arguments,
    { query: 'UAL "428"', layerId: 'flights' },
  );
  assert.equal(
    normalizeForSpeech('Wind 12 m/s at 30000 ft, 400 kts'),
    'Wind 12 meters per second at 30000 feet, 400 knots',
  );
  const splitter = createSentenceSplitter({ minChars: 4, maxChars: 20 });
  const parts = splitter.push('one two three four five six seven eight');
  assert.ok(parts.length >= 1);
  assert.ok(parts.every((part) => part.length <= 20));
  assert.equal(
    checkLocalVoiceSupport({ hasWebGpu: true, isSecureContext: false }).ok,
    false,
  );
  assert.equal(
    checkLocalVoiceSupport({ hasWebGpu: true, maxBufferSize: 256e6 }).ok,
    false,
  );
});
