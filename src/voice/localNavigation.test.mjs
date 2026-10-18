import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localNavigationArguments,
  localNavigationIntent,
} from './localNavigation.js';
import { runLocalTurn } from './localConversation.js';
import { localChatPayload } from './localPrompt.js';
import { localAiConfig } from './localConfig.js';

test('Russian and English place commands preserve landmarks and use automatic framing', () => {
  for (const [text, query] of [
    ['Покажи Красную площадь', 'Красная площадь, Москва'],
    [' покажи красную площади в Москве.', 'Красная площадь, Москва'],
    [
      'Покажи мне Красную площадь в Москве, пожалуйста.',
      'Красная площадь, Москва',
    ],
    ['Перенеси меня на Красную площадь', 'Красная площадь, Москва'],
    ['Покажи Нью-Йорк', 'New York'],
    ['Найди Нью Йорк на карте', 'New York'],
    ['Покажи мне Казань', 'Казань'],
    ['Please show me Red Square on the map.', 'Red Square, Moscow'],
    ['Take me to the Eiffel Tower', 'the Eiffel Tower'],
    ['Fly to San Francisco', 'San Francisco'],
    ['Покажи 55.7539, 37.6208', '55.7539, 37.6208'],
  ])
    assert.deepEqual(
      localNavigationIntent(text),
      { query, waitForArrival: true },
      text,
    );
});

test('layers, descriptions, compound instructions and relative references are not geocoded as places', () => {
  for (const text of [
    'Расскажи о Красной площади',
    'Что такое красная почва?',
    'Покажи самолёты',
    'Покажи ближайший самолёт',
    'Покажи слой спутников',
    'Покажи всю Землю',
    'Покажи это',
    'Покажи где мы',
    'Приблизь поближе',
    'Покажи Нью-Йорк и включи самолёты',
    'Show me aircraft near London',
    'Show London and tell me about it',
    'Show me the globe',
    'Покажи Москву с высоты 1000 метров',
  ])
    assert.equal(localNavigationIntent(text), null, text);
});

test('untrusted camera arguments cannot override a named destination or arrival waiting', () => {
  assert.deepEqual(
    localNavigationArguments(
      {
        locationId: 'nyc',
        query: 'Красная площадь',
        latitude: 40.7128,
        longitude: -74.006,
        rangeM: 10000000,
        viewMode: 'overview',
        waitForArrival: false,
      },
      'Покажи Красную площадь',
    ),
    {
      query: 'Красная площадь, Москва',
      waitForArrival: true,
    },
  );
  assert.throws(
    () => localNavigationArguments({ query: '55.75, 37.62' }, 'Покажи Москву'),
    /invented coordinates/,
  );
  assert.deepEqual(
    localNavigationArguments({ query: '55.75, 37.62' }, 'Покажи 55.75, 37.62'),
    {
      query: '55.75, 37.62',
      waitForArrival: true,
    },
  );
});

test('a direct navigation executes without asking Bonsai and speaks only after arrival', async () => {
  let arrive;
  const events = [],
    calls = [];
  const pending = runLocalTurn({
    text: 'Покажи Красную площадь',
    request: () =>
      assert.fail('Direct navigation must not depend on model prose'),
    emit: (event) => events.push(event),
    runAction: (name, args) => {
      calls.push({ name, args });
      return new Promise((resolve) => {
        arrive = resolve;
      });
    },
  });
  assert.deepEqual(calls, [
    {
      name: 'fly_to_location',
      args: {
        query: 'Красная площадь, Москва',
        waitForArrival: true,
      },
    },
  ]);
  assert.equal(events.filter((event) => event.role === 'assistant').length, 0);
  arrive({ ok: true, arrived: true, label: 'Красная площадь, Москва' });
  const result = await pending;
  assert.equal(result.text, 'Показываю: Красная площадь, Москва.');
  assert.deepEqual(
    result.history.map((message) => message.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
});

test('failed, cancelled and unconfirmed navigation never claims the destination is visible', async () => {
  for (const outcome of [
    { ok: false },
    { ok: false, cancelled: true },
    { ok: true },
  ]) {
    const result = await runLocalTurn({
      text: 'Покажи Нью-Йорк',
      runAction: async () => outcome,
      request: () => assert.fail('No generated success claims'),
    });
    assert.doesNotMatch(result.text, /Показываю|Нью-Йорк/u);
  }
});

test('cancellation suppresses a late arrival and assistant confirmation', async () => {
  const lifetime = new AbortController(),
    events = [];
  await assert.rejects(
    runLocalTurn({
      text: 'Покажи Нью-Йорк',
      signal: lifetime.signal,
      emit: (event) => events.push(event),
      runAction: async () => {
        lifetime.abort();
        return { ok: true, arrived: true, label: 'New York' };
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(
    events.some((event) => event.role === 'assistant'),
    false,
  );
});

test('model-generated navigation is also protected from runaway range and invented coordinates', async () => {
  let round = 0;
  const calls = [];
  const result = await runLocalTurn({
    text: 'Хочу увидеть Красную площадь',
    request: async () => ({
      message:
        round++ === 0
          ? {
              content: null,
              tool_calls: [
                {
                  id: 'nav',
                  type: 'function',
                  function: {
                    name: 'fly_to_location',
                    arguments: JSON.stringify({
                      query: 'Красная площадь',
                      latitude: 55.7558,
                      longitude: 37.6178,
                      rangeM: 10000000,
                      waitForArrival: false,
                    }),
                  },
                },
              ],
            }
          : { content: 'Мы на Красной площади!' },
    }),
    runAction: async (name, args) => {
      calls.push({ name, args });
      return { ok: false };
    },
  });
  assert.deepEqual(calls, [
    {
      name: 'fly_to_location',
      args: {
        query: 'Красная площадь, Москва',
        waitForArrival: true,
      },
    },
  ]);
  assert.match(result.text, /Не удалось/u);
});

test('Bonsai navigation schema exposes only a place query, not optional camera numbers', () => {
  const payload = localChatPayload(
    [{ role: 'user', content: 'Покажи Нью-Йорк' }],
    localAiConfig(),
  );
  const navigation = payload.tools.find(
    (tool) => tool.function.name === 'fly_to_location',
  ).function;
  assert.deepEqual(Object.keys(navigation.parameters.properties), ['query']);
  assert.deepEqual(navigation.parameters.required, ['query']);
  assert.match(payload.messages[0].content, /arrived=true/);
});
