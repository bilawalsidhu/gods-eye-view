import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentConsoleDom,
  consoleTemplateIds,
  fakeStorage,
} from '../testSupport/agentConsoleDom.mjs';
import {
  AGENT_SELECTION_STORAGE_KEY,
  AGENT_STATUS,
  describeToolCall,
  describeToolResult,
  describeWarning,
  modelOptionLabel,
  mountAgentConsole,
  pickInitialModel,
  pickInitialProvider,
  providerOptionLabel,
  readStoredSelection,
  writeStoredSelection,
} from './agentConsole.js';

const PROVIDERS = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'hosted',
    configured: false,
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'hosted',
    configured: true,
    apiKeyEnv: 'OPENROUTER_API_KEY',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'local',
    configured: true,
    apiKeyEnv: null,
  },
];

const MODELS = [
  {
    id: 'qwen3:4b',
    label: 'qwen3:4b',
    costPerCommandUsd: 0,
    supportsVision: false,
  },
  {
    id: 'llama3.2:3b',
    label: 'llama3.2:3b',
    costPerCommandUsd: 0,
    supportsVision: true,
  },
];

/** A fetch stand-in answering the console's two listing endpoints. */
function stubEndpoints({
  config = {
    providers: PROVIDERS,
    defaultProvider: 'ollama',
    defaultModel: null,
  },
  models = { models: MODELS, defaultModel: null },
  commands = [],
  failConfig = null,
  failModels = null,
} = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url === '/api/agent/config') {
      if (failConfig)
        return { ok: false, status: 503, json: async () => failConfig };
      return { ok: true, status: 200, json: async () => config };
    }
    if (url.startsWith('/api/agent/models')) {
      if (failModels)
        return { ok: false, status: 502, json: async () => failModels };
      return { ok: true, status: 200, json: async () => models };
    }
    const turn = commands.shift() ?? {
      message: { role: 'assistant', content: 'Done.' },
      toolCalls: [],
      warnings: [],
    };
    return { ok: true, status: 200, json: async () => turn };
  };
  impl.calls = calls;
  return impl;
}

/** Mount the console, then let its first-open loads settle. */
async function mounted(options = {}) {
  const dom = agentConsoleDom();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl: stubEndpoints(),
    storage: fakeStorage(),
    ...options,
    ...(options.root ? {} : {}),
  });
  return { dom, console: console_ };
}

test('the console mounts against the ids the shipped template declares', () => {
  const ids = consoleTemplateIds();
  for (const id of [
    'agent-console',
    'agent-console-chip',
    'agent-console-close',
    'agent-provider',
    'agent-model',
    'agent-transcript',
    'agent-form',
    'agent-input',
    'agent-send',
    'agent-status',
    'agent-cost',
  ]) {
    assert.ok(ids.includes(id), `the template lost #${id}`);
  }
});

test('mounting without the markup returns null rather than throwing', () => {
  const empty = { createElement: () => ({}), getElementById: () => null };
  assert.equal(
    mountAgentConsole({ root: empty, runAction: async () => ({}) }),
    null,
  );
  assert.equal(
    mountAgentConsole({ root: undefined, runAction: async () => ({}) }),
    null,
  );
});

test('a tool call is summarized rather than dumped as JSON', () => {
  assert.equal(describeToolCall('zoom_to_globe', {}), 'zoom_to_globe');
  assert.equal(describeToolCall('zoom_to_globe', undefined), 'zoom_to_globe');
  assert.equal(
    describeToolCall('fly_to_location', { query: 'Tokyo', rangeM: 2000 }),
    'fly_to_location query=Tokyo rangeM=2000',
  );
  assert.equal(
    describeToolCall('analyst_query', {
      layers: ['flights', 'military'],
      scope: { kind: 'view' },
    }),
    'analyst_query layers=[2] scope={…}',
  );
  assert.equal(
    describeToolCall('f', { a: 1, b: 2, c: 3, d: 4, e: 5 }),
    'f a=1 b=2 c=3 +2',
  );
  assert.match(describeToolCall('f', { q: 'x'.repeat(50) }), /q=x{32}$/);
});

test('a tool outcome shows the same ok flag the model is reading', () => {
  assert.equal(describeToolResult({ ok: true }), 'ok');
  assert.equal(describeToolResult({ ok: true, partial: true }), 'partial');
  assert.equal(describeToolResult({ ok: false }), 'failed');
  assert.equal(
    describeToolResult({ ok: false, error: 'Nothing matched' }),
    'failed: Nothing matched',
  );
  assert.equal(describeToolResult(null), 'done');
  assert.equal(describeToolResult('x'), 'done');
});

test('an unconfigured provider says which variable would configure it', () => {
  assert.equal(
    providerOptionLabel(PROVIDERS[0]),
    'OpenAI (needs OPENAI_API_KEY)',
  );
  assert.equal(providerOptionLabel(PROVIDERS[2]), 'Ollama');
});

test('a model option shows cost and vision, and says nothing it does not know', () => {
  assert.equal(
    modelOptionLabel({ label: 'qwen3:4b', costPerCommandUsd: 0 }),
    'qwen3:4b  ·  free',
  );
  assert.equal(
    modelOptionLabel({
      label: 'm',
      costPerCommandUsd: 0.00082,
      supportsVision: true,
    }),
    'm  ·  ~$0.00082 · vision',
  );
  // OpenAI publishes no prices through /v1/models, so the option says nothing
  // rather than implying the command is free.
  assert.equal(
    modelOptionLabel({ label: 'gpt-5-mini', costPerCommandUsd: null }),
    'gpt-5-mini',
  );
  assert.equal(modelOptionLabel({ label: 'gpt-5-mini' }), 'gpt-5-mini');
});

test('a warning is shown with its remedy attached', () => {
  assert.equal(
    describeWarning({ message: 'Truncated.', remedy: 'Raise the window.' }),
    'Truncated. Raise the window.',
  );
  assert.equal(describeWarning({ message: 'Truncated.' }), 'Truncated.');
  assert.equal(describeWarning(null), 'The provider reported a problem.');
});

test('a remembered choice wins, then the configured default, then the first offered', () => {
  assert.equal(
    pickInitialModel(MODELS, { remembered: 'llama3.2:3b' }).id,
    'llama3.2:3b',
  );
  assert.equal(
    pickInitialModel(MODELS, {
      remembered: 'gone',
      configuredDefault: 'llama3.2:3b',
    }).id,
    'llama3.2:3b',
  );
  assert.equal(pickInitialModel(MODELS, {}).id, 'qwen3:4b');
  assert.equal(pickInitialModel([], {}), null);
  assert.equal(pickInitialModel(null), null);
});

test('an unconfigured provider is never preselected over a configured one', () => {
  assert.equal(
    pickInitialProvider(PROVIDERS, { remembered: 'ollama' }),
    'ollama',
  );
  // Remembered but no longer configured, so the server default takes over.
  assert.equal(
    pickInitialProvider(PROVIDERS, {
      remembered: 'openai',
      configuredDefault: 'openrouter',
    }),
    'openrouter',
  );
  assert.equal(
    pickInitialProvider(PROVIDERS, { configuredDefault: 'openai' }),
    'openrouter',
  );
  assert.equal(pickInitialProvider([PROVIDERS[0]], {}), 'openai');
  assert.equal(pickInitialProvider([], {}), null);
  assert.equal(pickInitialProvider(null, {}), null);
});

test('the remembered selection round-trips, and junk in storage is ignored', () => {
  const storage = fakeStorage();
  assert.equal(readStoredSelection(storage), null);
  writeStoredSelection({ provider: 'ollama', model: 'qwen3:4b' }, storage);
  assert.deepEqual(readStoredSelection(storage), {
    provider: 'ollama',
    model: 'qwen3:4b',
  });
  storage.setItem(AGENT_SELECTION_STORAGE_KEY, 'not json');
  assert.equal(readStoredSelection(storage), null);
  storage.setItem(AGENT_SELECTION_STORAGE_KEY, '7');
  assert.equal(readStoredSelection(storage), null);
  storage.setItem(AGENT_SELECTION_STORAGE_KEY, '{"provider":1,"model":2}');
  assert.deepEqual(readStoredSelection(storage), {
    provider: null,
    model: null,
  });
});

test('storage that throws degrades to no preference instead of breaking the console', () => {
  const storage = fakeStorage({ throws: true });
  assert.equal(readStoredSelection(storage), null);
  assert.doesNotThrow(() =>
    writeStoredSelection({ provider: 'ollama' }, storage),
  );
});

test('nothing is fetched until the console is opened', async () => {
  const dom = agentConsoleDom();
  const fetchImpl = stubEndpoints();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl,
    storage: fakeStorage(),
  });
  assert.equal(dom.chip.hidden, false);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(dom.status.textContent, AGENT_STATUS.READY);
  console_.destroy();
});

test('opening loads the providers and models and preselects a usable pair', async () => {
  const dom = agentConsoleDom();
  const fetchImpl = stubEndpoints();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl,
    storage: fakeStorage(),
  });
  dom.click(dom.chip);
  await new Promise(setImmediate);

  assert.equal(dom.dialog.open, true);
  assert.equal(dom.chip.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(
    dom.providerSelect.children.map((option) => option.textContent),
    ['OpenAI (needs OPENAI_API_KEY)', 'OpenRouter', 'Ollama'],
  );
  assert.equal(dom.providerSelect.value, 'ollama');
  assert.equal(dom.modelSelect.value, 'qwen3:4b');
  assert.equal(dom.cost.textContent, 'free');
  assert.equal(dom.status.textContent, AGENT_STATUS.READY);
  assert.equal(dom.input.disabled, false);
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.url),
    ['/api/agent/config', '/api/agent/models?provider=ollama'],
  );
  console_.destroy();
});

test('the listing is fetched once, not again on every reopen', async () => {
  const dom = agentConsoleDom();
  const fetchImpl = stubEndpoints();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl,
    storage: fakeStorage(),
  });
  dom.click(dom.chip);
  await new Promise(setImmediate);
  dom.click(dom.chip);
  assert.equal(dom.dialog.open, false);
  dom.click(dom.chip);
  await new Promise(setImmediate);
  assert.equal(fetchImpl.calls.length, 2);
  console_.destroy();
});

test('the close button and Escape both close the dialog and correct the chip', async () => {
  const dom = agentConsoleDom();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl: stubEndpoints(),
    storage: fakeStorage(),
  });
  dom.click(dom.chip);
  await new Promise(setImmediate);
  dom.click(dom.closeButton);
  assert.equal(dom.dialog.open, false);
  assert.equal(dom.chip.getAttribute('aria-expanded'), 'false');

  dom.click(dom.chip);
  await new Promise(setImmediate);
  dom.keydown('Escape');
  assert.equal(dom.dialog.open, false);
  // A closed console must not keep swallowing Escape from the rest of the app.
  dom.keydown('Escape');
  assert.equal(dom.dialog.open, false);
  console_.destroy();
});

test('Escape closes the console even when focus is outside it', async () => {
  // A provider with no usable model leaves the input disabled, so nothing
  // inside the dialog can hold focus; a keydown listener on the dialog itself
  // would never see the key.
  const dom = agentConsoleDom();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl: stubEndpoints({ failModels: { error: 'Cannot reach Ollama.' } }),
    storage: fakeStorage(),
  });
  dom.click(dom.chip);
  await new Promise(setImmediate);
  assert.equal(dom.input.disabled, true);
  dom.keydown('Escape');
  assert.equal(dom.dialog.open, false);
  console_.destroy();
});

test('a destroyed console releases the Escape key it had claimed', async () => {
  const dom = agentConsoleDom();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl: stubEndpoints(),
    storage: fakeStorage(),
  });
  dom.click(dom.chip);
  await new Promise(setImmediate);
  let seen = 0;
  dom.document.addEventListener('keydown', () => {
    seen += 1;
  });
  console_.destroy();
  dom.keydown('Escape');
  assert.equal(seen, 1, 'the console still handled a key after teardown');
});

test('an unconfigured provider names its variable and refuses input', async () => {
  const dom = agentConsoleDom();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl: stubEndpoints({
      config: {
        providers: PROVIDERS,
        defaultProvider: 'openai',
        defaultModel: 'gpt-5-mini',
      },
    }),
    storage: fakeStorage({ throws: false }),
  });
  dom.click(dom.chip);
  await new Promise(setImmediate);
  dom.select(dom.providerSelect, 'openai');
  await new Promise(setImmediate);
  assert.match(dom.status.textContent, /UNAVAILABLE · set OPENAI_API_KEY/);
  assert.equal(dom.input.disabled, true);
  assert.equal(
    dom.providerSelect.disabled,
    false,
    'the operator cannot change back',
  );
  console_.destroy();
});

test('a provider with no usable model says so and refuses input', async () => {
  const dom = agentConsoleDom();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl: stubEndpoints({ models: { models: [], defaultModel: null } }),
    storage: fakeStorage(),
  });
  dom.click(dom.chip);
  await new Promise(setImmediate);
  assert.match(dom.status.textContent, /UNAVAILABLE · no usable models/);
  assert.equal(dom.input.disabled, true);
  assert.equal(dom.cost.textContent, 'n/a');
  console_.destroy();
});

test('an unreachable backend writes one error entry and stays usable', async () => {
  const dom = agentConsoleDom();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl: stubEndpoints({ failConfig: { error: 'Unknown API route' } }),
    storage: fakeStorage(),
  });
  dom.click(dom.chip);
  await new Promise(setImmediate);
  assert.deepEqual(dom.entries(), [['error', 'Unknown API route']]);
  assert.equal(dom.status.textContent, AGENT_STATUS.UNAVAILABLE);
  console_.destroy();
});

test('a failed model listing is reported without losing the provider picker', async () => {
  const dom = agentConsoleDom();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl: stubEndpoints({
      failModels: {
        error:
          'Cannot reach Ollama at http://localhost:11434/v1. Is the daemon running?',
      },
    }),
    storage: fakeStorage(),
  });
  dom.click(dom.chip);
  await new Promise(setImmediate);
  assert.match(dom.entries()[0][1], /Is the daemon running\?/);
  assert.equal(dom.providerSelect.disabled, false);
  console_.destroy();
});

test('one typed command renders the command, its tools and the answer', async () => {
  const ran = [];
  const dom = agentConsoleDom();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async (name, args) => {
      ran.push([name, args]);
      return { ok: true, action: name };
    },
    fetchImpl: stubEndpoints({
      commands: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'zoom_to_globe', arguments: '{}' },
              },
            ],
          },
          toolCalls: [{ id: 'c1', name: 'zoom_to_globe', args: {} }],
          warnings: [],
        },
        {
          message: { role: 'assistant', content: 'Globe view.' },
          toolCalls: [],
          warnings: [],
        },
      ],
    }),
    storage: fakeStorage(),
  });
  dom.click(dom.chip);
  await new Promise(setImmediate);
  dom.input.value = 'zoom out to full planet view';
  dom.submit();
  await new Promise(setImmediate);
  await new Promise(setImmediate);

  assert.deepEqual(ran, [['zoom_to_globe', {}]]);
  assert.deepEqual(dom.entries(), [
    ['user', 'zoom out to full planet view'],
    ['tool', 'zoom_to_globe'],
    ['agent', 'Globe view.'],
  ]);
  assert.equal(dom.transcript.children[1].dataset.outcome, 'ok');
  assert.equal(dom.input.value, '');
  assert.equal(dom.input.disabled, false);
  assert.equal(dom.status.textContent, AGENT_STATUS.READY);
  console_.destroy();
});

test('a server warning appears in the transcript with its remedy', async () => {
  const dom = agentConsoleDom();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl: stubEndpoints({
      commands: [
        {
          message: { role: 'assistant', content: 'Flying to Tokyo.' },
          toolCalls: [],
          warnings: [
            {
              code: 'prefix-truncated',
              message: 'Ollama may have truncated the tool prefix.',
              remedy: 'Set OLLAMA_CONTEXT_LENGTH=16384.',
            },
          ],
        },
      ],
    }),
    storage: fakeStorage(),
  });
  dom.click(dom.chip);
  await new Promise(setImmediate);
  dom.input.value = 'fly to Tokyo';
  dom.submit();
  await new Promise(setImmediate);
  assert.deepEqual(dom.entries(), [
    ['user', 'fly to Tokyo'],
    [
      'warning',
      'Ollama may have truncated the tool prefix. Set OLLAMA_CONTEXT_LENGTH=16384.',
    ],
    ['agent', 'Flying to Tokyo.'],
  ]);
  console_.destroy();
});

test('an empty input is not a command, and no model means no send', async () => {
  const dom = agentConsoleDom();
  const fetchImpl = stubEndpoints({
    models: { models: [], defaultModel: null },
  });
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl,
    storage: fakeStorage(),
  });
  dom.click(dom.chip);
  await new Promise(setImmediate);
  dom.input.value = '   ';
  dom.submit();
  await new Promise(setImmediate);
  assert.deepEqual(dom.entries(), []);

  dom.input.value = 'zoom out';
  dom.submit();
  await new Promise(setImmediate);
  assert.deepEqual(dom.entries(), [
    ['error', 'Select a model before sending a command.'],
  ]);
  assert.equal(
    fetchImpl.calls.filter((call) => call.url === '/api/agent/command').length,
    0,
  );
  console_.destroy();
});

test('changing provider remembers the choice and starts a clean transcript', async () => {
  const storage = fakeStorage();
  const dom = agentConsoleDom();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl: stubEndpoints({
      commands: [
        {
          message: { role: 'assistant', content: 'Done.' },
          toolCalls: [],
          warnings: [],
        },
      ],
    }),
    storage,
  });
  dom.click(dom.chip);
  await new Promise(setImmediate);
  dom.input.value = 'zoom out';
  dom.submit();
  await new Promise(setImmediate);
  assert.equal(console_.session.transcript.length, 2);

  dom.select(dom.providerSelect, 'openrouter');
  await new Promise(setImmediate);
  assert.deepEqual(console_.session.transcript, []);
  assert.deepEqual(readStoredSelection(storage), {
    provider: 'openrouter',
    model: null,
  });
  console_.destroy();
});

test('changing model remembers it and refreshes the cost readout', async () => {
  const storage = fakeStorage();
  const dom = agentConsoleDom();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl: stubEndpoints({
      models: {
        models: [
          { id: 'free', label: 'free', costPerCommandUsd: 0 },
          { id: 'paid', label: 'paid', costPerCommandUsd: 0.00082 },
        ],
      },
    }),
    storage,
  });
  dom.click(dom.chip);
  await new Promise(setImmediate);
  assert.equal(dom.cost.textContent, 'free');
  dom.select(dom.modelSelect, 'paid');
  assert.equal(dom.cost.textContent, '~$0.00082');
  assert.deepEqual(readStoredSelection(storage), {
    provider: 'ollama',
    model: 'paid',
  });
  console_.destroy();
});

test('destroying the console closes it, hides the chip and detaches its listeners', async () => {
  const dom = agentConsoleDom();
  const fetchImpl = stubEndpoints();
  const console_ = mountAgentConsole({
    root: dom.document,
    runAction: async () => ({ ok: true }),
    fetchImpl,
    storage: fakeStorage(),
  });
  dom.click(dom.chip);
  await new Promise(setImmediate);
  console_.destroy();

  assert.equal(dom.dialog.open, false);
  assert.equal(dom.chip.hidden, true);
  assert.equal(dom.chip.getAttribute('aria-expanded'), 'false');
  const before = fetchImpl.calls.length;
  dom.click(dom.chip);
  dom.input.value = 'zoom out';
  dom.submit();
  dom.select(dom.providerSelect, 'openrouter');
  await new Promise(setImmediate);
  assert.equal(
    fetchImpl.calls.length,
    before,
    'a detached listener still fired',
  );
  assert.equal(dom.dialog.open, false);
});

test('the console exposes open and close for the application to drive', async () => {
  const { dom, console: console_ } = await mounted();
  console_.open();
  await new Promise(setImmediate);
  assert.equal(dom.dialog.open, true);
  console_.close();
  assert.equal(dom.dialog.open, false);
  console_.destroy();
});
