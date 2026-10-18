import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localCommandPlan,
  localSpeechChunks,
  runLocalAction,
} from './localCommands.js';
import { runLocalTurn } from './localConversation.js';
import { LOCAL_ACTION_TOOLS, localChatPayload } from './localPrompt.js';
import { GEV_ACTION_SCHEMAS } from './actionSchemas.js';
import { localAiConfig } from './localConfig.js';

const cases = [
  [
    'Пожалуйста, найди мне рейс EZY94CG и следи за ним.',
    'track_entity',
    { query: 'EZY94CG', layerId: 'flights' },
  ],
  [
    'Find flight BAW42 and follow it',
    'track_entity',
    { query: 'BAW42', layerId: 'flights' },
  ],
  [
    'Приблизь камеру немного',
    'adjust_camera_zoom',
    { direction: 'in', amount: 'little' },
  ],
  [
    'Немного приблизь',
    'adjust_camera_zoom',
    { direction: 'in', amount: 'little' },
  ],
  ['Приблизь', 'adjust_camera_zoom', { direction: 'in', amount: 'medium' }],
  ['Отдали сильно', 'adjust_camera_zoom', { direction: 'out', amount: 'lot' }],
  ['Подальше', 'adjust_camera_zoom', { direction: 'out', amount: 'medium' }],
  [
    'Please zoom in a little.',
    'adjust_camera_zoom',
    { direction: 'in', amount: 'little' },
  ],
  ['Zoom out a lot', 'adjust_camera_zoom', { direction: 'out', amount: 'lot' }],
  [
    'Приблизь Красную площадь',
    'fly_to_location',
    {
      query: 'Красная площадь, Москва',
      waitForArrival: true,
      viewMode: 'close',
    },
  ],
  [
    'Zoom to the Eiffel Tower',
    'fly_to_location',
    { query: 'the Eiffel Tower', waitForArrival: true, viewMode: 'close' },
  ],
  ['Покажи всю Землю', 'zoom_to_globe', {}],
  ['Show me the globe', 'zoom_to_globe', {}],
  [
    'Следи за самолётом AFL123',
    'track_entity',
    { query: 'AFL123', layerId: 'flights' },
  ],
  [
    'Track flight BAW42',
    'track_entity',
    { query: 'BAW42', layerId: 'flights' },
  ],
  [
    'Follow military aircraft RCH101',
    'track_entity',
    { query: 'RCH101', layerId: 'military' },
  ],
  [
    'Следи за военным бортом RCH101',
    'track_entity',
    { query: 'RCH101', layerId: 'military' },
  ],
  [
    'Отслеживай спутник ISS',
    'track_entity',
    { query: 'ISS', layerId: 'satellites' },
  ],
  [
    'Follow ship EVER GIVEN',
    'track_entity',
    { query: 'EVER GIVEN', layerId: 'ais-live-vessels' },
  ],
  [
    'Выбери ближайший самолёт',
    'select_nearest_aircraft',
    { layerId: 'flights' },
  ],
  [
    'Следи за ближайшим самолётом над Лондоном',
    'select_nearest_aircraft',
    { layerId: 'flights', locationQuery: 'Лондоном' },
  ],
  [
    'Follow the nearest military aircraft near London',
    'select_nearest_aircraft',
    { layerId: 'military', locationQuery: 'London' },
  ],
  ['Останови слежение', 'stop_tracking', {}],
  ['Stop following', 'stop_tracking', {}],
  [
    'Включи самолёты',
    'set_layer_visibility',
    { layerId: 'flights', enabled: true },
  ],
  [
    'Hide satellites',
    'set_layer_visibility',
    { layerId: 'satellites', enabled: false },
  ],
];
for (const [text, name, args] of cases)
  test(`direct command: ${text}`, async () => {
    assert.deepEqual(localCommandPlan(text), [{ name, args }]);
    const calls = [];
    const answer = await runLocalTurn({
      text,
      request: () => assert.fail('Ordinary control must not load Bonsai'),
      runAction: async (tool, values) => {
        calls.push([tool, values]);
        return { ok: true, arrived: true, label: 'Target', scene: { basemap: { target: { latitude: 30, longitude: -97 } } } };
      },
    });
    const expected = name === 'select_nearest_aircraft' && !args.locationQuery ? { ...args, latitude: 30, longitude: -97 } : args;
    assert.deepEqual(calls.at(-1), [name, expected]);
    if (name === 'track_entity')
      assert.deepEqual(calls[0], [
        'set_layer_visibility',
        { layerId: args.layerId, enabled: true },
      ]);
    assert.ok(answer.text);
  });

test('compound navigation, zoom and tracking preserve order and stop on failed arrival', async () => {
  for (const success of [true, false]) {
    const calls = [];
    await runLocalTurn({
      text: 'Покажи Москву и приблизь немного, затем следи за AFL123',
      request: () => assert.fail('Compound controls are deterministic'),
      runAction: async (name) => {
        calls.push(name);
        return { ok: true, arrived: success };
      },
    });
    assert.deepEqual(
      calls,
      success
        ? [
            'fly_to_location',
            'adjust_camera_zoom',
            'set_layer_visibility',
            'track_entity',
          ]
        : ['fly_to_location'],
    );
  }
});

test('ambiguous, negative and partly understood requests do not execute a partial plan', () => {
  for (const text of [
    'Не приближай',
    'Не следи за AFL123',
    'Show London and explain its history',
    'Следи за самолётом который рядом',
    'приблизь и сделай красиво',
    'zoom in; zoom out; zoom in; zoom out; zoom in',
  ])
    assert.equal(localCommandPlan(text), null, text);
});

test('selected contact uses its real identifier and never invents one', async () => {
  for (const selected of [
    null,
    { layerId: 'flights', name: 'AFL123', properties: { icao24: 'abcdef' } },
  ]) {
    const calls = [];
    const reply = await runLocalTurn({
      text: 'Следи за этим самолётом',
      request: () => assert.fail('No model required'),
      runAction: async (name, args) => {
        calls.push([name, args]);
        return { ok: true, selected };
      },
    });
    if (selected)
      assert.deepEqual(calls.at(-1), [
        'track_entity',
        { query: 'abcdef', layerId: 'flights' },
      ]);
    else {
      assert.equal(calls.length, 1);
      assert.doesNotMatch(reply.text, /^Слежу/u);
    }
  }
});

test('missing aircraft, failed layer and cancellation cannot be narrated as successful tracking', async () => {
  for (const failedTool of ['set_layer_visibility', 'track_entity']) {
    const calls = [];
    const reply = await runLocalTurn({
      text: 'Follow flight BAW42',
      runAction: async (name) => {
        calls.push(name);
        return {
          ok: name !== failedTool,
          error: name === failedTool ? 'Missing data' : undefined,
        };
      },
    });
    assert.match(reply.text, /Could not/);
    if (failedTool === 'set_layer_visibility')
      assert.deepEqual(calls, [failedTool]);
  }
  const lifetime = new AbortController();
  const calls = [];
  await assert.rejects(
    runLocalTurn({
      text: 'Follow flight BAW42',
      signal: lifetime.signal,
      runAction: async (name) => {
        calls.push(name);
        lifetime.abort();
        return { ok: true };
      },
    }),
    { name: 'AbortError' },
  );
  assert.deepEqual(calls, ['set_layer_visibility']);
});

test('all API map actions are accessible; unrelated schemas do not inflate a small request', () => {
  assert.deepEqual(
    LOCAL_ACTION_TOOLS.map((t) => t.function.name),
    GEV_ACTION_SCHEMAS.map((t) => t.name),
  );
  const config = localAiConfig({ LOCAL_AI_PROFILE: 'low' });
  const messages = [{ role: 'user', content: 'Hello' }];
  const initial = localChatPayload(messages, config);
  assert.equal(initial.tools.length, 4);
  assert.ok(JSON.stringify(initial).length < 4000);
  const next = localChatPayload(
    [
      ...messages,
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            function: {
              name: 'get_map_tools',
              arguments: '{"group":"annotations"}',
            },
          },
        ],
      },
    ],
    config,
  );
  assert.ok(next.tools.some((tool) => tool.function.name === 'annotate_map'));
});

test('Piper chunks bound inference allocations without dropping text', () => {
  for (const text of [
    'Короткая фраза.',
    'Предложение с несколькими словами. '.repeat(100).trim(),
    'x'.repeat(1000),
  ]) {
    const chunks = localSpeechChunks(text);
    assert.ok(chunks.every((chunk) => chunk.length <= 240));
    assert.equal(chunks.join('').replace(/\s/gu, ''), text.replace(/\s/gu, ''));
  }
  assert.deepEqual(localSpeechChunks(''), []);
});

test('invalid generated arguments cannot silently invert controls or alter the map', async () => {
  for (const [name, args] of [
    ['set_layer_visibility', { layerId: 'flights', enabled: 'false' }],
    ['adjust_camera_zoom', { direction: 'out', amount: 'infinite' }],
    ['adjust_camera_zoom', { direction: 'in' }],
    ['track_entity', { query: 'BAW42', layerId: 'wrong' }],
    ['move_camera', { motion: 'orbit', secret: true }],
    ['fly_to_location', { latitude: Infinity }],
  ])
    await assert.rejects(
      runLocalAction(name, args, () =>
        assert.fail('Invalid arguments reached map'),
      ),
    );
});

test('a model tool is confirmed directly without a second expensive generation', async () => {
  let requests = 0;
  const answer = await runLocalTurn({
    text: 'Сделай масштаб побольше',
    request: async () => {
      assert.equal(++requests, 1);
      return {
        message: {
          tool_calls: [
            {
              id: 'z',
              type: 'function',
              function: {
                name: 'adjust_camera_zoom',
                arguments: '{"direction":"in","amount":"little"}',
              },
            },
          ],
        },
      };
    },
    runAction: async () => ({ ok: true }),
  });
  assert.equal(answer.text, 'Приближаю.');
});

test('nearest aircraft uses the viewed ground target and never camera coordinates', async () => {
  const calls = [];
  await runLocalAction('select_nearest_aircraft', { layerId: 'flights' }, async (name, args) => {
    calls.push([name, args]);
    return { ok: true, scene: { camera: { latitude: 10, longitude: 20 }, basemap: { target: { latitude: 30, longitude: 40 } } } };
  });
  assert.deepEqual(calls, [
    ['get_entity_context', { scope: 'in_view', limit: 1 }],
    ['select_nearest_aircraft', { layerId: 'flights', latitude: 30, longitude: 40 }],
  ]);
  const missing = [];
  const result = await runLocalAction('select_nearest_aircraft', { layerId: 'flights' }, async (name) => {
    missing.push(name); return { ok: true, scene: { camera: { latitude: 10, longitude: 20 } } };
  });
  assert.equal(result.ok, false);
  assert.deepEqual(missing, ['get_entity_context']);
});
