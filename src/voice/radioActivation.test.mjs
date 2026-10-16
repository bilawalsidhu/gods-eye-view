import test from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from '../data/manager.js';
import { createGevActionRunner } from './gevActions.js';
import { GEV_ACTION_SCHEMAS } from './actionSchemas.js';
import { createRealtimeTokenHandler } from '../../server/providers/openai/realtime.js';
import { createGeminiLiveConfig } from '../../server/providers/gemini/config.js';
import { standaloneVoiceTools } from '../../server/standalone/voiceTools.js';

function radioHarness(t, selected = null) {
  const calls = [];
  const state = {
    stationCount: 2,
    selected,
    audioState: 'stopped',
    volume: 0.8,
    filter: 'all',
  };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
  const module = {
    id: 'radio',
    name: 'Internet Radio',
    updateInterval: 0,
    init() {
      calls.push(['init']);
    },
    enable() {
      calls.push(['enable']);
    },
    update() {
      calls.push(['update']);
    },
    disable() {
      calls.push(['disable']);
    },
    destroy() {
      calls.push(['destroy']);
    },
    getUIState: () => ({ ...state }),
    getStats: () => ({ count: state.stationCount }),
    playSelected(options) {
      calls.push(['playSelected', options]);
      state.audioState = 'playing';
      return true;
    },
    cycleStation(direction, options) {
      calls.push(['cycleStation', direction, options]);
      state.selected = { id: 'nearest', name: 'Nearest station' };
      if (options.autoplay) module.playSelected();
      return true;
    },
    selectRequestedStation(criteria, options) {
      calls.push(['selectRequestedStation', criteria, options]);
      state.selected = { id: 'news-us', name: 'US News' };
      state.filter = criteria.categoryId;
      if (options.autoplay) module.playSelected();
      return state.selected;
    },
  };
  const manager = new DataLayerManager(viewer);
  manager.register(module);
  t.after(() => manager.destroyLayer('radio'));
  return {
    manager,
    state,
    calls,
    runner: createGevActionRunner({
      viewer,
      styleManager: {},
      dataManager: manager,
    }),
  };
}

test('Radio enable and generic visibility use the real lifecycle without selecting or playing', async (t) => {
  for (const selected of [
    null,
    { id: 'remembered', name: 'Remembered station' },
  ]) {
    for (const [tool, args] of [
      ['control_radio', { action: 'enable' }],
      ['control_radio', { action: 'enable', category: 'news', country: 'US' }],
      ['set_layer_visibility', { layerId: 'radio', enabled: true }],
    ]) {
      const { runner, manager, calls, state } = radioHarness(t, selected);
      const result = await runner(tool, args);
      assert.equal(result.ok, true);
      assert.equal(manager.isEnabled('radio'), true);
      assert.equal(result.lifecycleState, 'enabled');
      assert.equal(result.lifecycleUncertain, false);
      assert.notEqual(result.radioPlaybackRequested, true);
      assert.deepEqual(calls, [['init'], ['enable'], ['update']]);
      assert.equal(state.selected, selected);
      assert.equal(state.audioState, 'stopped');
      // Repeated enable is idempotent and cannot start the remembered station.
      const again = await runner(tool, args);
      assert.equal(again.ok, true);
      assert.notEqual(again.radioPlaybackRequested, true);
      assert.deepEqual(calls, [['init'], ['enable'], ['update']]);
    }
  }
});

test('explicit play and resume still prepare the selected or nearest station for handoff', async (t) => {
  for (const action of ['play', 'resume']) {
    for (const selected of [
      null,
      { id: 'remembered', name: 'Remembered station' },
    ]) {
      const { runner, manager, calls, state } = radioHarness(t, selected);
      const result = await runner('control_radio', { action });
      assert.equal(result.ok, true);
      assert.equal(result.radioAction, action);
      assert.equal(result.radioPlaybackRequested, true);
      assert.equal(result.stationId, selected?.id || 'nearest');
      assert.equal(manager.isEnabled('radio'), true);
      assert.equal(
        state.audioState,
        'stopped',
        'the shared handoff still owns playback',
      );
      assert.equal(calls.filter(([name]) => name === 'playSelected').length, 0);
      assert.deepEqual(
        calls.filter(([name]) => name === 'cycleStation'),
        selected
          ? []
          : [['cycleStation', 1, { focus: false, autoplay: false }]],
      );
    }
  }
});

test('explicit qualified playback and station selection preserve the requested criteria', async (t) => {
  for (const action of ['play', 'select']) {
    const { runner, calls, state } = radioHarness(t);
    const result = await runner('control_radio', {
      action,
      category: 'news',
      country: 'US',
    });
    assert.equal(result.ok, true);
    assert.equal(result.radioAction, 'select');
    assert.equal(result.stationId, 'news-us');
    assert.equal(result.radioPlaybackRequested, true);
    assert.equal(state.audioState, 'stopped');
    assert.deepEqual(calls.at(-1), [
      'selectRequestedStation',
      {
        categoryId: 'news',
        anchor: null,
        country: 'US',
        stationQuery: '',
      },
      { autoplay: false },
    ]);
    assert.equal(calls.filter(([name]) => name === 'playSelected').length, 0);
  }
});

async function serializedOpenAiSession() {
  let payload;
  const handler = createRealtimeTokenHandler({
    environment: {},
    resolveApiKey: () => 'fixture-key',
    resolveOAuthAccessToken: () => {
      throw new Error('unexpected credential access');
    },
    tools: standaloneVoiceTools(),
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return Response.json({ value: 'fixture-ephemeral' });
    },
  });
  const response = { setHeader() {}, end() {} };
  await handler(
    {
      method: 'POST',
      url: '/api/realtime/token',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    },
    response,
  );
  assert.equal(response.statusCode, 200);
  return payload.session;
}

function withoutDescriptions(value) {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description')
      .map(([key, child]) => [key, withoutDescriptions(child)]),
  );
}

test('serialized OpenAI and Gemini production guidance separate layer enable from playback', async () => {
  const openAi = await serializedOpenAiSession();
  const gemini = JSON.parse(
    JSON.stringify(
      createGeminiLiveConfig(undefined, 'push-to-talk', standaloneVoiceTools()),
    ),
  );
  const geminiInstructions = gemini.systemInstruction.parts
    .map(({ text }) => text)
    .join('\n');
  assert.equal(geminiInstructions, openAi.instructions);
  const radioRule = openAi.instructions
    .split('\n')
    .find((line) => line.startsWith('Radio requests'));
  assert.match(radioRule, /"Turn on\/start the radio" means action=enable/);
  assert.match(radioRule, /without starting audio or selecting a station/);
  assert.match(
    radioRule,
    /Playback requires an explicit play, listen, or resume request/,
  );
  assert.doesNotMatch(
    openAi.instructions,
    /"Turn on\/start the radio" means action=play/,
  );
  const openAiRadio = openAi.tools.find(({ name }) => name === 'control_radio');
  const geminiRadio = gemini.tools
    .flatMap(({ functionDeclarations }) => functionDeclarations)
    .find(({ name }) => name === 'control_radio');
  assert.equal(geminiRadio.description, openAiRadio.description);
  assert.deepEqual(geminiRadio.parametersJsonSchema, openAiRadio.parameters);
  assert.match(
    openAiRadio.description,
    /"Turn on\/start the radio" means enable/,
  );
  assert.match(
    openAiRadio.parameters.properties.action.description,
    /Use enable for turn on\/start\/show\/enable/,
  );
  assert.doesNotMatch(
    openAiRadio.description,
    /Use play only for an unqualified "turn on\/start/,
  );
  const canonical = GEV_ACTION_SCHEMAS.find(
    ({ name }) => name === 'control_radio',
  );
  assert.deepEqual(
    withoutDescriptions(openAiRadio.parameters),
    canonical.parameters,
  );
  assert.deepEqual(openAiRadio.parameters.required, ['action']);
  assert.equal(openAiRadio.parameters.additionalProperties, false);
  assert.deepEqual(openAiRadio.parameters.properties.action.enum, [
    'enable',
    'disable',
    'play',
    'resume',
    'pause',
    'stop',
    'next',
    'previous',
    'volume',
    'select',
    'status',
  ]);
});
