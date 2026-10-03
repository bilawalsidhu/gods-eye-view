import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderCommands,
  readVoiceProvider,
} from './providerCommands.js';
import { createVoiceCommands as bind } from './sessionCommands.js';
import { VOICE_INACTIVITY_STORAGE_KEY } from './inactivity.js';

function element(properties = {}) {
  const target = new EventTarget();
  Object.assign(target, properties);
  target.attributes = {};
  target.setAttribute = (name, value) => {
    target.attributes[name] = String(value);
  };
  target.focus = () => {
    target.focused = true;
  };
  return target;
}

function control() {
  const button = element();
  button.setAttribute = () => {};
  const select = element();
  const customInput = element({ value: '5' });
  customInput.setCustomValidity = () => {};
  return {
    root: {
      dataset: {},
      remove() {
        this.removed = true;
      },
    },
    button,
    providerSelect: select,
    voiceSettingsButton: element(),
    voiceSettingsPanel: element({ hidden: true }),
    voiceSettingsClose: element(),
    inactivitySelect: element({ value: '' }),
    inactivityCustomRow: { hidden: true },
    inactivityCustomInput: customInput,
    inactivityNote: {},
    providerLimitNote: {},
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
  globalThis.window = new EventTarget();
  const lifetime = new AbortController();
  const hooks = {};
  const starts = [];
  const stops = [];
  const views = [];
  const values = new Map();
  if (value != null) values.set('gev.voice.provider', value);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, next) => values.set(key, next),
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
    stored: () => values.get('gev.voice.provider') ?? null,
    storedValue: (key) => values.get(key) ?? null,
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
  assert.equal(original.setVoiceSettingsOpen(true), true);
  assert.equal(f.views[0].voiceSettingsPanel.hidden, false);
  assert.equal(original.setVoiceInactivityMinutes(3), true);
  assert.equal(f.views[0].inactivitySelect.value, '3');
  assert.equal(f.storedValue(VOICE_INACTIVITY_STORAGE_KEY), '3');
  f.views[0].providerSelect.value = 'gemini';
  f.views[0].providerSelect.dispatchEvent(new Event('change'));
  assert.equal(window.__gevVoiceCommands, original);
  assert.equal(original.provider, 'gemini');
  assert.equal(f.stored(), 'gemini');
  assert.equal(f.views[0].root.removed, true);
  assert.equal(f.views[0].providerField.removed, true);
  assert.equal(f.views[1].tierButton.hidden, true);
  assert.equal(f.views[1].voiceSettingsPanel.hidden, false);
  assert.equal(
    f.views[1].voiceSettingsButton.attributes['aria-expanded'],
    'true',
  );
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

test('provider replacement preserves the browser-local inactivity preference', (t) => {
  const f = setup(t);
  const first = f.views[0];
  assert.equal(first.inactivitySelect.value, '5');
  first.inactivitySelect.value = 'custom';
  first.inactivitySelect.dispatchEvent(new Event('change'));
  first.inactivityCustomInput.value = '12';
  first.inactivityCustomInput.dispatchEvent(new Event('input'));
  assert.equal(f.storedValue(VOICE_INACTIVITY_STORAGE_KEY), '12');
  f.controls.setProvider('gemini');
  assert.equal(f.views[1].inactivitySelect.value, 'custom');
  assert.equal(f.views[1].inactivityCustomInput.value, '12');
});

test('both providers close voice settings through equivalent terminal routes', async (t) => {
  for (const provider of ['openai', 'gemini']) {
    for (const route of [
      'public-stop',
      'session-stop',
      'session-preserve-status',
      'preserve-status',
      'button-stop',
      'error',
      'goAway',
    ]) {
      await t.test(`${provider}: ${route}`, async (t) => {
        const f = setup(t, { value: provider });
        await f.controls.start();
        f.controls.setVoiceInactivityMinutes(12);
        f.controls.setVoiceSettingsOpen(true);
        assert.equal(f.controls.deferVoiceSettingsUntilCockpitExit(), true);
        const view = f.views[0];
        view.voiceSettingsPanel.ownerDocument = {
          activeElement: view.inactivityCustomInput,
        };
        view.voiceSettingsPanel.contains = (candidate) =>
          candidate === view.inactivityCustomInput;
        if (route === 'public-stop') f.controls.stop();
        if (route === 'session-stop') f.controls.session.stop();
        if (route === 'session-preserve-status')
          f.controls.session.stop({ preserveStatus: true });
        if (route === 'preserve-status')
          f.controls.stop({ preserveStatus: true });
        if (route === 'button-stop')
          view.button.dispatchEvent(new Event('click'));
        if (route === 'error' || route === 'goAway') {
          f.hooks[provider].emit({
            type: 'state',
            state: 'error',
            detail: route,
          });
        }
        globalThis.window.dispatchEvent(
          new CustomEvent('gev:cockpit-mode-changed', {
            detail: { active: false },
          }),
        );
        await Promise.resolve();
        assert.equal(view.voiceSettingsPanel.hidden, true);
        assert.equal(
          view.voiceSettingsButton.attributes['aria-expanded'],
          'false',
        );
        assert.equal(view.voiceSettingsButton.focused, true);
        assert.equal(f.storedValue(VOICE_INACTIVITY_STORAGE_KEY), '12');
        if (!['preserve-status', 'session-preserve-status'].includes(route))
          assert.equal(f.controls.isActive(), false);
      });
    }
  }
});

test('terminal events close settings before a pending provider replacement remounts', async (t) => {
  for (const provider of ['openai', 'gemini']) {
    for (const route of ['public-stop', 'session-stop', 'error']) {
      await t.test(`${provider}: ${route}`, async (t) => {
        const f = setup(t, { value: provider });
        await f.controls.start();
        f.controls.setVoiceSettingsOpen(true);
        const successor = provider === 'openai' ? 'gemini' : 'openai';
        assert.equal(f.controls.requestProviderChange(successor).pending, true);
        if (route === 'public-stop') f.controls.stop();
        if (route === 'session-stop') f.controls.session.stop();
        if (route === 'error')
          f.hooks[provider].emit({ type: 'state', state: 'error' });
        assert.equal(f.controls.provider, successor);
        assert.equal(f.views.length, 2);
        assert.equal(f.views[0].voiceSettingsPanel.hidden, true);
        assert.equal(f.views[1].voiceSettingsPanel.hidden, true);
        assert.equal(
          f.views[1].voiceSettingsButton.attributes['aria-expanded'],
          'false',
        );
      });
    }
  }
});

test('closing settings keeps voice active and disposed provider events cannot close its successor', async (t) => {
  for (const provider of ['openai', 'gemini']) {
    await t.test(provider, async (t) => {
      const f = setup(t, { value: provider });
      await f.controls.start();
      f.controls.setVoiceSettingsOpen(true);
      f.views[0].voiceSettingsClose.dispatchEvent(new Event('click'));
      assert.equal(f.views[0].voiceSettingsPanel.hidden, true);
      assert.equal(f.controls.isActive(), true);
      assert.deepEqual(f.stops, []);
      f.controls.setVoiceSettingsOpen(true);
      const oldHooks = f.hooks[provider];
      f.controls.setProvider(provider === 'openai' ? 'gemini' : 'openai');
      await f.controls.start();
      const view = f.views[1];
      assert.equal(view.voiceSettingsPanel.hidden, false);
      for (const event of [
        { type: 'state', state: 'error' },
        { type: 'state', state: 'idle' },
        { type: 'completion', status: 'completed' },
      ])
        oldHooks.emit(event);
      assert.equal(view.voiceSettingsPanel.hidden, false);
      assert.equal(
        view.voiceSettingsButton.attributes['aria-expanded'],
        'true',
      );
      assert.equal(f.controls.state, 'listening');
    });
  }
});
