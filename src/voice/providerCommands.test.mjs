import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderCommands,
  readVoiceProvider,
} from './providerCommands.js';
import { createVoiceCommands as bind } from './sessionCommands.js';

function control() {
  const button = new EventTarget();
  button.setAttribute = () => {};
  const select = new EventTarget();
  return {
    root: {
      dataset: {},
      remove() {
        this.removed = true;
      },
    },
    button,
    providerSelect: select,
    providerField: {
      remove() {
        this.removed = true;
      },
    },
    status: {},
    detail: {},
    tierButton: {},
    costValue: {},
    helpDetail: {},
  };
}
function setup(
  t,
  { value = null, runner = async () => ({ ok: true }), deferredStart } = {},
) {
  const prior = globalThis.window;
  globalThis.window = {};
  const lifetime = new AbortController();
  const hooks = {};
  const starts = [];
  const stops = [];
  const views = [];
  const storage = {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
  };
  const factories = Object.fromEntries(
    ['openai', 'gemini'].map((provider) => [
      provider,
      (h) => {
        hooks[provider] = h;
        return {
          capabilities: {
            costControls: provider === 'openai',
            pushToTalk: true,
          },
          start: async () => {
            starts.push(provider);
            if (provider === 'openai' && deferredStart) await deferredStart;
            h.emit({ type: 'state', state: 'listening', detail: provider });
          },
          stop: () => {
            stops.push(provider);
          },
          sendText: (text) => provider + ':' + text,
          sendMapEvent: () => true,
        };
      },
    ]),
  );
  const controls = createProviderCommands(
    {
      runner,
      signal: lifetime.signal,
      createControl: () => {
        const view = control();
        views.push(view);
        return view;
      },
    },
    { bind, factories, storage },
  );
  t.after(() => {
    controls.destroy();
    globalThis.window = prior;
  });
  return {
    controls,
    hooks,
    starts,
    stops,
    views,
    lifetime,
    stored: () => value,
  };
}

test('provider preference defaults to OpenAI and ignores invalid or unavailable storage', () => {
  assert.equal(readVoiceProvider({ getItem: () => 'gemini' }), 'gemini');
  for (const value of [null, '', 'other', 'GEMINI']) {
    assert.equal(readVoiceProvider({ getItem: () => value }), 'openai');
  }
  assert.equal(
    readVoiceProvider({
      getItem() {
        throw new Error('denied');
      },
    }),
    'openai',
  );
});

test('selector stops the active provider, persists the choice, and keeps one public facade', async (t) => {
  const f = setup(t);
  const original = f.controls;
  await original.start();
  assert.equal(original.status, 'listening');
  assert.equal(f.views[0].tierButton.hidden, false);
  f.views[0].providerSelect.value = 'gemini';
  f.views[0].providerSelect.dispatchEvent(new Event('change'));
  assert.equal(window.__gevVoiceCommands, original);
  assert.equal(original.provider, 'gemini');
  assert.equal(f.stored(), 'gemini');
  assert.equal(f.views[0].root.removed, true);
  assert.equal(f.views[0].providerField.removed, true);
  assert.equal(f.views[1].tierButton.hidden, true);
  assert.equal(original.status, 'idle');
  assert.deepEqual(f.starts, ['openai']);
  await original.start();
  assert.equal(original.sendTextCommand('hello'), 'gemini:hello');
  assert.equal(original.status, 'listening');
  assert.deepEqual(f.stops, ['openai']);
  f.views[0].providerSelect.value = 'openai';
  f.views[0].providerSelect.dispatchEvent(new Event('change'));
  assert.equal(
    original.provider,
    'gemini',
    'old selector listener was released',
  );
});

test('the shared action runner keeps its identity and remains callable across provider switches', async (t) => {
  const calls = [];
  const result = { ok: true, hudVariant: 'minimal' };
  const runner = async (...args) => {
    calls.push(args);
    return result;
  };
  const f = setup(t, { runner });
  const args = { variant: 'minimal' };
  const options = { signal: new AbortController().signal };
  for (const provider of ['openai', 'gemini', 'openai']) {
    f.controls.setProvider(provider);
    assert.equal(f.controls.runner, runner);
    assert.equal(window.__gevVoiceCommands.runner, runner);
    assert.equal(
      await f.controls.runner('set_hud_variant', args, options),
      result,
    );
    assert.equal(f.controls.status, 'idle');
  }
  assert.deepEqual(
    calls,
    Array.from({ length: 3 }, () => ['set_hud_variant', args, options]),
  );
  assert.deepEqual(
    f.starts,
    [],
    'direct map actions do not start a voice connection',
  );
});

test('switch during tool execution aborts old work without disturbing the new session', async (t) => {
  let resolve;
  let actionSignal;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const f = setup(t, {
    runner: async (_name, _args, options) => {
      actionSignal = options.signal;
      return pending;
    },
  });
  await f.controls.start();
  const oldAction = f.hooks.openai.runAction('fly_to_location', {});
  f.controls.setProvider('gemini');
  assert.equal(actionSignal.aborted, true);
  await f.controls.start();
  resolve({ ok: true });
  await assert.rejects(oldAction, { name: 'AbortError' });
  assert.equal(f.controls.status, 'listening');
  assert.equal(f.controls.provider, 'gemini');
});

test('late startup cannot revive a replaced provider; app teardown removes the latest controls', async (t) => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const f = setup(t, { deferredStart: pending });
  const first = f.controls.start();
  f.controls.setProvider('gemini');
  await f.controls.start();
  resolve();
  await first;
  assert.equal(f.controls.status, 'listening');
  assert.equal(f.views[1].detail.textContent, 'gemini');
  f.lifetime.abort();
  assert.equal(f.controls.disposed, true);
  assert.equal(f.views[1].root.removed, true);
  assert.equal(f.views[1].providerField.removed, true);
  assert.equal(f.controls.setProvider('openai'), false);
  assert.equal(f.controls.start(), false);
  assert.equal(f.controls.sendTextCommand('late'), false);
});

test('restored Gemini choice retains the action runner without creating duplicate lifetimes', async (t) => {
  const result = { ok: true, hudVariant: 'tactical' };
  const runner = async (name) => {
    assert.equal(name, 'get_current_view_state');
    return result;
  };
  const f = setup(t, { value: 'gemini', runner });
  assert.equal(f.controls.provider, 'gemini');
  assert.equal(f.controls.runner, runner);
  assert.equal(await f.controls.runner('get_current_view_state'), result);
  assert.equal(f.controls.setProvider('gemini'), false);
  assert.equal(f.controls.setProvider('unrecognized'), false);
  assert.equal(f.views.length, 1);
  assert.deepEqual(f.starts, []);
});

test('a voice-requested provider change waits for completion, then remounts once', async (t) => {
  const f = setup(t);
  await f.controls.start();

  assert.deepEqual(f.controls.requestProviderChange('gemini'), {
    ok: true,
    changed: true,
    pending: true,
    previousProvider: 'openai',
  });
  assert.equal(f.controls.provider, 'openai');
  assert.equal(f.views.length, 1);

  f.hooks.openai.emit({
    type: 'completion',
    status: 'completed',
  });
  assert.equal(f.controls.provider, 'gemini');
  assert.equal(f.views.length, 2);
  assert.equal(f.stored(), 'gemini');
  assert.deepEqual(f.stops, ['openai']);
});
