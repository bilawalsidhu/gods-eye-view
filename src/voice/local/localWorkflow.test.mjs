// The on-device tier driving a scripted model: dependent calls continue
// (lookup, then track) and speech honors the shared say envelope.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalWebSession } from './localWebSession.js';
import {
  actionReply,
  fallbackAnswer,
  isMaterialReply,
  needsContinuation,
  needsSpokenAnswer,
} from './replies.js';
import { buildLocalTools } from './toolset.js';

/** A scripted model: `turn(text)` and `next(results)` return {calls, text}. */
function scriptedEngine({ turn, next }) {
  let ids = 0;
  const seen = [];
  return {
    seen,
    engine: {
      prepared: true,
      async ensure() {
        return { loads: [] };
      },
      llm: {
        turn(text, { onToolCalls }) {
          const turnId = ++ids;
          const done = (async () => {
            const step = (await turn(text)) || {};
            if (step.calls?.length) onToolCalls(step.calls);
            return {
              text: step.text || '',
              calls: step.calls || [],
              stats: {},
            };
          })();
          return { turnId, done };
        },
        async continueTurn(turnId, results, { onToolCalls, onDelta }) {
          seen.push(results);
          const step = (await next(results)) || {};
          if (step.calls?.length) onToolCalls(step.calls);
          if (step.text) onDelta(step.text);
          return { stats: {} };
        },
        release() {},
        cancel() {},
      },
      terminate() {},
    },
  };
}

async function localSession(runAction, script) {
  const spoken = [];
  const model = scriptedEngine(script);
  const session = createLocalWebSession({
    emit: () => {},
    runAction,
    ui: null,
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    runtime: {
      createEngine: () => model.engine,
      probeSupport: async () => ({ ok: true }),
      checkStorage: async () => ({ note: null }),
      openMicrophone: async () => {
        throw new Error('no microphone in tests');
      },
      createOutput: () => ({
        id: 'test',
        stream: null,
        speak: async (sentence) => {
          spoken.push(sentence);
          return { ms: 1, delayMs: 0 };
        },
        idle: async () => {},
        stop() {},
        close() {},
      }),
    },
  });
  await session.start();
  return { session, spoken, seen: model.seen };
}

const byName = (results, name) =>
  results.find((entry) => entry.name === name)?.response;

test('"follow the nearest aircraft" looks up, then continues to track', async () => {
  const ran = [];
  const { session, seen } = await localSession(
    async (name, args) => {
      ran.push(name);
      if (name === 'analyst_query')
        return {
          ok: true,
          count: 1,
          scopeLabel: 'in view',
          items: [{ callsign: 'UAL428', layerId: 'flights' }],
        };
      return { ok: true, say: `Tracking ${args.query}.` };
    },
    {
      turn: () => ({
        calls: [
          {
            name: 'analyst_query',
            arguments: { layers: ['flights'], sortBy: 'distance', limit: 1 },
          },
        ],
      }),
      next: (results) =>
        byName(results, 'analyst_query')
          ? {
              calls: [{ name: 'track_entity', arguments: { query: 'UAL428' } }],
            }
          : {},
    },
  );
  const record = await session.local.runText('follow the nearest aircraft');
  await session.local.speechIdle();
  assert.deepEqual(ran, ['analyst_query', 'track_entity']);
  assert.equal(seen.length, 1, 'only the lookup result went back to the model');
  assert.match(record.reply, /Tracking UAL428/);
});

test('local speech says the envelope line, including after an acknowledgement', async () => {
  const unavailable = {
    ok: true,
    layerId: 'flights',
    enabled: true,
    feedState: 'unavailable',
    say: 'Flights on, but its feed is unavailable.',
  };
  assert.equal(
    actionReply('set_layer_visibility', { layerId: 'flights' }, unavailable),
    'Flights on, but its feed is unavailable.',
  );
  assert.equal(
    isMaterialReply(
      'set_layer_visibility',
      { layerId: 'flights' },
      unavailable,
    ),
    true,
  );
  assert.equal(
    isMaterialReply(
      'set_layer_visibility',
      { layerId: 'flights' },
      { ...unavailable, feedState: 'nominal', say: 'Flights on.' },
    ),
    false,
    'a plain confirmation adds nothing after "Turning on flights"',
  );
  const { session, spoken } = await localSession(
    async () => {
      // Slower than the acknowledgement threshold.
      await new Promise((resolve) => setTimeout(resolve, 800));
      return unavailable;
    },
    {
      turn: () => ({
        calls: [
          {
            name: 'set_layer_visibility',
            arguments: { layerId: 'flights', enabled: true },
          },
        ],
      }),
      next: () => ({}),
    },
  );
  await session.local.runText('turn on flights');
  await session.local.speechIdle();
  assert.deepEqual(spoken, [
    'Turning on flights.',
    'Flights on, but its feed is unavailable.',
  ]);
});

test('lower bounds and partial answers survive the deterministic fallback', () => {
  assert.equal(
    fallbackAnswer('analyst_query', {
      ok: true,
      count: 500,
      complete: false,
      scopeLabel: 'inside Kathmandu',
      items: [],
    }),
    'At least 500 inside Kathmandu.',
  );
  assert.match(
    fallbackAnswer('analyst_query', {
      ok: true,
      count: 3,
      complete: true,
      partial: true,
      unanswered: ['military'],
      scopeLabel: 'anywhere in the loaded data',
      items: [],
    }),
    /military not answered/,
  );
  assert.ok(needsContinuation('analyst_query', { ok: true }));
  assert.ok(!needsContinuation('analyst_query', { cancelled: true }));
  assert.ok(needsSpokenAnswer('get_entity_context'));
  assert.ok(!needsSpokenAnswer('set_layer_visibility'));
});

test('the on-device profile never offers pointing and lists only voice core actions', () => {
  const tools = buildLocalTools().map((tool) => tool.function);
  assert.equal(JSON.stringify(tools).includes('"pointer"'), false);
  const names = tools.map((tool) => tool.name);
  for (const name of ['resolve_area', 'find_imagery', 'osm_query'])
    assert.equal(names.includes(name), false, name);
  assert.equal(JSON.stringify(tools).includes('areaId'), false);
});

test('compact annotations offer only types their arguments can express', () => {
  const tools = buildLocalTools().map((tool) => tool.function);
  const annotate = tools.find((tool) => tool.name === 'annotate_map');
  assert.deepEqual(
    annotate.parameters.properties.annotations.items.properties.type.enum,
    ['pin', 'highlight', 'area', 'label'],
  );
});

test('natural voice drops audio that arrives after speech was stopped', async () => {
  const { createKokoroOutput } = await import('./speechOutput.js');
  let answer;
  const output = createKokoroOutput({
    client: {
      synthesize: () => new Promise((resolve) => (answer = resolve)),
      flush() {},
    },
  });
  const spoken = output.speak('Zoomed in.');
  output.stop();
  answer({ samples: new Float32Array(10), sampleRate: 24000, ms: 1 });
  assert.equal(await spoken, null, 'nothing is queued after stop()');
});
