import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderCommands,
  readVoiceProvider,
} from './providerCommands.js';
import { createVoiceCommands as bind } from './sessionCommands.js';

function element(properties = {}) {
  const target = new EventTarget();
  Object.assign(target, properties);
  target.attributes = {};
  target.setAttribute = (name, value) => {
    target.attributes[name] = String(value);
  };
  target.getAttribute = (name) => target.attributes[name] ?? null;
  target.focus = () => {
    target.focused = true;
  };
  return target;
}

function control() {
  const button = element();
  button.setAttribute = () => {};
  const select = element();
  select.options = [];
  select.ownerDocument = { createElement: () => ({}) };
  select.replaceChildren = (...options) => {
    select.options = options;
  };
  const view = {
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
  return view;
}
function setup(
  t,
  {
    value = null,
    runner = async () => ({ ok: true }),
    deferredStart,
    startGate,
    startOptionsAvailable = true,
    storedValues = new Map(),
    supportedProviders = ['openai', 'gemini'],
    factoryProviders = ['openai', 'gemini'],
  } = {},
) {
  const prior = globalThis.window;
  const priorDocument = globalThis.document;
  globalThis.window = new EventTarget();
  const lifetime = new AbortController();
  let controls;
  t.after(() => {
    controls?.destroy();
    globalThis.window = prior;
    globalThis.document = priorDocument;
  });
  let clock = 1000;
  const timers = new Map();
  let timerSequence = 0;
  const hooks = {};
  const starts = [];
  const stops = [];
  const claims = [];
  const releases = [];
  const localOutputBegins = [];
  const localOutputEnds = [];
  const localOutputLifecycle = [];
  const views = [];
  globalThis.document = {
    getElementById: (id) =>
      id === 'gev-voice-provider' ? views.at(-1)?.providerSelect : null,
  };
  const sourceEvents = [];
  const sessionEvents = [];
  const sentTexts = [];
  const mountedControls = [];
  const instances = [];
  const values = storedValues;
  const storageWrites = [];
  if (value != null) values.set('gev.voice.provider', value);
  const storage = {
    getItem: (key) => {
      return values.get(key) ?? null;
    },
    setItem: (key, next) => {
      storageWrites.push([key, next]);
      values.set(key, next);
    },
  };
  const factories = Object.fromEntries(
    factoryProviders.map((provider) => [
      provider,
      (h) => {
        hooks[provider] = h;
        let startGeneration = 0;
        const instance = {
          provider,
          id: instances.length,
          hooks: h,
          startSettings: [],
          stopSettings: [],
          starts: [],
          input: { pushToTalkMode: false, pushToTalkKeyHeld: false },
          microphoneEnabled: false,
        };
        instances.push(instance);
        const adapter = {
          capabilities: {
            costControls: provider === 'openai',
            pushToTalk: true,
          },
          start: (settings = {}) => {
            const generation = ++startGeneration;
            starts.push(provider);
            instance.startSettings.push({ ...settings });
            instance.input.pushToTalkMode = Boolean(settings.pushToTalk);
            h.emit({ type: 'state', state: 'connecting', detail: provider });
            const promise = (async () => {
              const gate =
                startGate?.(instance) ??
                (provider === 'openai' ? deferredStart : null);
              if (gate) await gate;
              // Real adapters own a startup generation and suppress work after
              // stop/disposal. Model that contract, not an impossible late emit.
              if (generation !== startGeneration || h.signal.aborted) return;
              instance.microphoneEnabled =
                !instance.input.pushToTalkMode ||
                instance.input.pushToTalkKeyHeld;
              h.emit({ type: 'state', state: 'listening', detail: provider });
            })();
            instance.starts.push(promise);
            return promise;
          },
          stop: (settings = {}) => {
            startGeneration++;
            stops.push(provider);
            instance.stopSettings.push({ ...settings });
            instance.input.pushToTalkMode = false;
            instance.input.pushToTalkKeyHeld = false;
            instance.microphoneEnabled = false;
          },
          sendText: (text) => {
            sentTexts.push({ provider, text });
            return provider + ':' + text;
          },
          sendMapEvent: () => true,
          claimLocalProviderCommand: () => {
            claims.push(provider);
            return true;
          },
          releaseLocalProviderCommand: () => {
            releases.push(provider);
            localOutputLifecycle.push(`${provider}:release`);
          },
          beginLocalOutput: () => {
            localOutputBegins.push(provider);
            localOutputLifecycle.push(`${provider}:begin`);
            return true;
          },
          endLocalOutput: () => {
            localOutputEnds.push(provider);
            localOutputLifecycle.push(`${provider}:end`);
          },
        };
        if (startOptionsAvailable)
          adapter.getStartOptions = () => ({
            pushToTalk: instance.input.pushToTalkMode,
          });
        instance.adapter = adapter;
        return adapter;
      },
    ]),
  );
  controls = createProviderCommands(
    {
      runner,
      supportedProviders,
      signal: lifetime.signal,
      createControl: () => {
        const view = control();
        views.push(view);
        return view;
      },
      createCard: () => ({
        enabled: true,
        setEnabled(value) {
          this.enabled = value;
        },
        handle() {},
        destroy() {},
      }),
    },
    {
      bind: (options) => {
        sourceEvents.push(options.onSessionEvent);
        const onSessionEvent = options.onSessionEvent;
        const mounted = bind({
          ...options,
          onSessionEvent: (event) => {
            sessionEvents.push(event);
            onSessionEvent(event);
          },
        });
        mountedControls.push(mounted);
        return mounted;
      },
      factories,
      storage,
      now: () => clock,
      setTimer: (callback, delay) => {
        const id = ++timerSequence;
        timers.set(id, { callback, deadline: clock + delay });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    },
  );
  return {
    controls,
    hooks,
    starts,
    stops,
    claims,
    releases,
    localOutputBegins,
    localOutputEnds,
    localOutputLifecycle,
    views,
    sourceEvents,
    sessionEvents,
    sentTexts,
    mountedControls,
    instances,
    storageWrites,
    lifetime,
    stored: () => values.get('gev.voice.provider') ?? null,
    storedValue: (key) => values.get(key) ?? null,
    timers,
    setClock: (value) => {
      clock = value;
    },
    selectProvider: (next) => {
      const before = controls.provider;
      const select = views.at(-1)?.providerSelect;
      if (!select) return false;
      select.value = next;
      select.dispatchEvent(new Event('change'));
      return controls.provider !== before;
    },
    expireTimers: () => {
      clock += 30000;
      for (const [id, { callback, deadline }] of [...timers])
        if (clock >= deadline) {
          timers.delete(id);
          callback();
        }
    },
    advanceTime: (milliseconds) => {
      clock += milliseconds;
      for (const [id, { callback, deadline }] of [...timers])
        if (clock >= deadline) {
          timers.delete(id);
          callback();
        }
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settleStarts(instance) {
  await Promise.allSettled(instance.starts);
  await Promise.resolve(); // Let createVoiceSession publish any caught failure.
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
  assert.equal(f.views[1].tierButton.hidden, true);
  assert.deepEqual(f.starts, ['openai', 'gemini']);
  assert.deepEqual(f.instances[1].startSettings, [{ pushToTalk: false }]);
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
    f.selectProvider(provider);
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
  f.selectProvider('gemini');
  assert.equal(actionSignal.aborted, true);
  assert.deepEqual(f.starts, ['openai', 'gemini']);
  resolve({ ok: true });
  await assert.rejects(oldAction, { name: 'AbortError' });
  assert.equal(f.controls.status, 'listening');
  assert.equal(f.controls.provider, 'gemini');
});

test('provider swaps retain the shared runner and facade lifetime until final teardown', async (t) => {
  let disposed = false;
  let disposals = 0;
  let resets = 0;
  const runner = async () => {
    assert.equal(
      disposed,
      false,
      'replacement must not permanently dispose the runner',
    );
    return { ok: true };
  };
  runner.resetConversation = () => resets++;
  runner.dispose = () => {
    disposed = true;
    disposals++;
  };
  const f = setup(t, { runner });
  const lifetime = f.controls.signal;
  let lifetimeAborts = 0;
  lifetime.addEventListener('abort', () => lifetimeAborts++);
  await f.controls.start();
  for (const provider of ['gemini', 'openai']) {
    const outgoing = f.controls.session.signal;
    f.selectProvider(provider);
    assert.equal(outgoing.aborted, true);
    assert.equal(f.controls.signal, lifetime);
    assert.equal(lifetime.aborted, false);
    assert.equal(disposals, 0);
    assert.equal(f.controls.status, 'listening');
    assert.deepEqual(await f.hooks[provider].runAction('zoom_to_globe', {}), {
      ok: true,
    });
  }
  assert.equal(resets, 2, 'each retired adapter forgets conversation state');
  f.controls.destroy();
  f.controls.destroy();
  f.controls.stop({ removeUi: true });
  f.lifetime.abort();
  assert.equal(lifetime.aborted, true);
  assert.equal(lifetimeAborts, 1);
  assert.equal(disposals, 1);
});

test('late startup cannot revive a replaced provider; app teardown removes the latest controls', async (t) => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const f = setup(t, { deferredStart: pending });
  const first = f.controls.start();
  f.selectProvider('gemini');
  assert.deepEqual(f.starts, ['openai', 'gemini']);
  resolve();
  await first;
  assert.equal(f.controls.status, 'listening');
  assert.equal(f.views[1].detail.textContent, 'gemini');
  f.lifetime.abort();
  assert.equal(f.controls.disposed, true);
  assert.equal(f.views[1].root.removed, true);
  assert.equal(f.selectProvider('openai'), false);
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
  assert.equal(f.selectProvider('gemini'), false);
  assert.equal(f.selectProvider('unrecognized'), false);
  assert.equal(f.views.length, 1);
  assert.deepEqual(f.starts, []);
});

for (const provider of ['openai', 'gemini']) {
  test(`${provider} sends clear provider requests to the active model without changing provider state`, async (t) => {
    const f = setup(t, { value: provider });
    await f.controls.start();
    const session = f.controls.session;
    const starts = [...f.starts];
    const stops = [...f.stops];
    const mountedViews = f.views.length;
    const requests = [
      provider === 'openai' ? 'Switch to Gemini' : 'Switch to OpenAI',
      `Switch to ${provider}`,
      'Select a voice provider',
      'Use another-provider as my voice provider',
    ];

    for (const text of requests)
      assert.equal(f.controls.sendTextCommand(text), `${provider}:${text}`);

    assert.deepEqual(
      f.sentTexts,
      requests.map((text) => ({ provider, text })),
    );
    assert.equal(f.controls.provider, provider);
    assert.equal(f.controls.session, session);
    assert.deepEqual(f.storageWrites, []);
    assert.deepEqual(f.starts, starts);
    assert.deepEqual(f.stops, stops);
    assert.equal(f.views.length, mountedViews);
    assert.deepEqual(f.claims, []);
    assert.deepEqual(f.releases, []);
    assert.equal(f.controls.session.adapter.acknowledgeLocalCommand, undefined);
    assert.deepEqual(f.localOutputBegins, []);
    assert.deepEqual(f.localOutputEnds, []);
  });

  test(`${provider} leaves spoken provider requests with the provider response already in progress`, async (t) => {
    const f = setup(t, { value: provider });
    await f.controls.start();
    const session = f.controls.session;
    const events = [
      {
        type: 'user-input-final',
        inputKind: 'speech',
        inputScope: 'utterance',
        inputId: 'provider-request',
        text: provider === 'openai' ? 'Switch to Gemini' : 'Switch to OpenAI',
      },
      {
        type: 'user-input-final',
        inputKind: 'speech',
        inputScope: 'segment',
        inputId: 'provider-request',
        text: ' actually keep the current provider',
      },
    ];

    for (const event of events) f.hooks[provider].emit(event);
    await Promise.resolve();

    assert.equal(f.controls.provider, provider);
    assert.equal(f.controls.session, session);
    assert.deepEqual(f.sentTexts, []);
    assert.deepEqual(f.storageWrites, []);
    assert.deepEqual(f.starts, [provider]);
    assert.deepEqual(f.stops, []);
    assert.equal(f.views.length, 1);
    assert.deepEqual(f.claims, []);
    assert.deepEqual(f.releases, []);
    assert.equal(f.controls.session.adapter.acknowledgeLocalCommand, undefined);
    assert.deepEqual(f.localOutputBegins, []);
    assert.deepEqual(f.localOutputEnds, []);
  });
}

for (const provider of ['openai', 'gemini']) {
  test(`${provider} button activation resumes exactly once after a selector change`, async (t) => {
    const f = setup(t, { value: provider });
    const successor = provider === 'openai' ? 'gemini' : 'openai';
    f.views[0].button.dispatchEvent(new Event('click'));
    assert.equal(f.controls.state, 'listening');
    assert.deepEqual(f.instances[0].startSettings, [{ pushToTalk: false }]);
    f.views[0].providerSelect.value = successor;
    f.views[0].providerSelect.dispatchEvent(new Event('change'));
    assert.equal(f.controls.provider, successor);
    assert.equal(f.views[1].providerSelect.focused, true);
    assert.equal(f.controls.state, 'listening');
    assert.deepEqual(f.starts, [provider, successor]);
    assert.deepEqual(f.instances[1].startSettings, [{ pushToTalk: false }]);
    await f.controls.start();
    assert.deepEqual(
      f.starts,
      [provider, successor],
      'an already active successor is not started twice',
    );
  });
}

for (const route of [
  'public-stop',
  'session-stop',
  'button-stop',
  'preserve-status',
  'session-preserve-status',
]) {
  test(`provider selection stays OFF after ${route}, even if a stale active state arrives`, async (t) => {
    const f = setup(t, {});
    await f.controls.start();
    if (route === 'public-stop') f.controls.stop();
    if (route === 'session-stop') f.controls.session.stop();
    if (route === 'button-stop')
      f.views[0].button.dispatchEvent(new Event('click'));
    if (route === 'preserve-status') f.controls.stop({ preserveStatus: true });
    if (route === 'session-preserve-status')
      f.controls.session.stop({ preserveStatus: true });
    // A stopped adapter may still have a queued presentation event. It must
    // not re-create the user's ON intent without a new connecting transition.
    f.hooks.openai.emit({
      type: 'state',
      state: 'listening',
      detail: 'late display state',
    });
    f.hooks.openai.emit({
      type: 'transcript',
      role: 'user',
      text: 'Show flights over London',
      final: true,
    });
    f.selectProvider('gemini');
    assert.equal(f.controls.provider, 'gemini');
    assert.equal(f.controls.state, 'idle');
    assert.deepEqual(f.starts, ['openai']);
    assert.deepEqual(f.instances[1].startSettings, []);
  });
}

test('a rejected old connect cannot stop the automatically connecting successor', async (t) => {
  const oldGate = deferred();
  const nextGate = deferred();
  const f = setup(t, {
    startGate: ({ id }) => (id === 0 ? oldGate.promise : nextGate.promise),
  });
  const first = f.controls.start();
  assert.equal(f.controls.state, 'connecting');
  f.selectProvider('gemini');
  assert.deepEqual(f.starts, ['openai', 'gemini']);
  assert.equal(f.controls.state, 'connecting');
  oldGate.reject(new Error('retired connect failed'));
  await first;
  assert.equal(f.controls.provider, 'gemini');
  assert.equal(f.controls.state, 'connecting');
  assert.deepEqual(f.instances[1].stopSettings, []);
  nextGate.resolve();
  await settleStarts(f.instances[1]);
  assert.equal(f.controls.state, 'listening');
});

test('rapid active switches start each replacement once and only the newest mount can finish', async (t) => {
  const gates = [deferred(), deferred(), deferred()];
  const f = setup(t, { startGate: ({ id }) => gates[id].promise });
  const first = f.controls.start();
  f.selectProvider('gemini');
  f.selectProvider('openai');
  assert.equal(f.controls.provider, 'openai');
  assert.equal(f.controls.state, 'connecting');
  assert.deepEqual(f.starts, ['openai', 'gemini', 'openai']);
  assert.equal(f.instances[0].hooks.signal.aborted, true);
  assert.equal(f.instances[1].hooks.signal.aborted, true);
  assert.equal(f.instances[2].hooks.signal.aborted, false);
  gates[1].resolve();
  gates[0].resolve();
  await first;
  await settleStarts(f.instances[1]);
  for (const instance of f.instances.slice(0, 2)) {
    instance.hooks.emit({ type: 'state', state: 'error', detail: 'retired' });
    instance.hooks.emit({ type: 'state', state: 'listening' });
  }
  assert.equal(f.controls.state, 'connecting');
  gates[2].resolve();
  await settleStarts(f.instances[2]);
  assert.equal(f.controls.state, 'listening');
  assert.equal(f.controls.session.signal, f.instances[2].hooks.signal);
  assert.deepEqual(
    f.instances.map((instance) => instance.startSettings.length),
    [1, 1, 1],
  );
});

for (const route of [
  'public-stop',
  'session-stop',
  'button-stop',
  'destroy',
  'parent-abort',
]) {
  test(`${route} defeats an automatic successor startup that has not settled`, async (t) => {
    const nextGate = deferred();
    const f = setup(t, {
      startGate: ({ provider }) =>
        provider === 'gemini' ? nextGate.promise : null,
    });
    await f.controls.start();
    f.selectProvider('gemini');
    assert.deepEqual(f.starts, ['openai', 'gemini']);
    assert.equal(f.controls.state, 'connecting');
    if (route === 'public-stop') f.controls.stop();
    if (route === 'session-stop') f.controls.session.stop();
    if (route === 'button-stop')
      f.views[1].button.dispatchEvent(new Event('click'));
    if (route === 'destroy') f.controls.destroy();
    if (route === 'parent-abort') f.lifetime.abort();
    nextGate.resolve();
    await settleStarts(f.instances[1]);
    assert.equal(f.controls.state, 'idle');
    assert.equal(f.instances[1].microphoneEnabled, false);
    assert.equal(f.instances[1].stopSettings.length, 1);
    assert.deepEqual(f.starts, ['openai', 'gemini']);
    if (route === 'destroy' || route === 'parent-abort') {
      assert.equal(f.controls.disposed, true);
      assert.equal(f.views[1].root.removed, true);
    } else {
      f.selectProvider('openai');
      assert.equal(f.controls.state, 'idle');
      assert.deepEqual(f.starts, ['openai', 'gemini']);
    }
  });
}

test('failed automatic startup keeps the selected provider in error without fallback or retries', async (t) => {
  const nextGate = deferred();
  const f = setup(t, {
    startGate: ({ provider }) =>
      provider === 'gemini' ? nextGate.promise : null,
  });
  await f.controls.start();
  f.selectProvider('gemini');
  assert.equal(f.controls.state, 'connecting');
  nextGate.reject(new Error('Microphone permission denied'));
  await settleStarts(f.instances[1]);
  assert.equal(f.controls.provider, 'gemini');
  assert.equal(f.stored(), 'gemini');
  assert.equal(f.controls.state, 'error');
  assert.equal(f.views[1].detail.textContent, 'Microphone permission denied');
  assert.equal(f.instances[0].hooks.signal.aborted, true);
  assert.deepEqual(f.instances[1].stopSettings, [{ preserveStatus: true }]);
  assert.deepEqual(f.starts, ['openai', 'gemini']);
  f.selectProvider('openai');
  assert.equal(f.controls.state, 'idle', 'failure cleared the resume intent');
  assert.deepEqual(f.starts, ['openai', 'gemini']);
});

for (const provider of ['openai', 'gemini']) {
  for (const pushToTalk of [false, true]) {
    test(`${provider} direct adapter activation preserves ${pushToTalk ? 'PTT' : 'open-mic'} mode without transferring a held key`, async (t) => {
      const f = setup(t, { value: provider });
      const original = f.instances[0];
      original.input.pushToTalkKeyHeld = pushToTalk;
      // Native PTT starts the controller rather than facade.start(). The
      // adapter emits connecting, then the common session observes its state.
      await original.adapter.start({ pushToTalk });
      assert.equal(f.controls.state, 'listening');
      f.selectProvider(provider === 'openai' ? 'gemini' : 'openai');
      const successor = f.instances[1];
      assert.equal(f.controls.state, 'listening');
      assert.deepEqual(successor.startSettings, [{ pushToTalk }]);
      assert.equal(
        original.input.pushToTalkMode,
        false,
        'retirement resets the old input after its settings were captured',
      );
      assert.equal(successor.input.pushToTalkKeyHeld, false);
      assert.equal(
        successor.microphoneEnabled,
        !pushToTalk,
        'PTT waits muted for a new physical hold',
      );
    });
  }
}

test('an adapter without resume options still resumes an active session in open-mic mode', async (t) => {
  const f = setup(t, { startOptionsAvailable: false });
  await f.controls.start();
  f.selectProvider('gemini');
  assert.equal(f.controls.state, 'listening');
  assert.deepEqual(f.instances[1].startSettings, [{ pushToTalk: false }]);
});

test('the public facade exposes no provider-mutation method', (t) => {
  const f = setup(t);
  assert.equal(f.controls.setProvider, undefined);
  assert.equal(f.controls.requestProviderChange, undefined);
  assert.equal(f.controls.provider, 'openai');
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.storageWrites, []);
});

test('supported factories determine restoration, facade selection and actual selector options', async (t) => {
  for (const config of [
    { supportedProviders: ['openai'], value: 'gemini', expected: 'openai' },
    { supportedProviders: ['gemini'], value: 'openai', expected: 'gemini' },
    {
      supportedProviders: ['gemini', 'openai'],
      factoryProviders: ['openai'],
      value: 'gemini',
      expected: 'openai',
    },
    { supportedProviders: ['unknown', 'gemini', 'gemini'], expected: 'gemini' },
  ]) {
    await t.test(JSON.stringify(config), async (t) => {
      const f = setup(t, config);
      assert.equal(f.controls.provider, config.expected);
      assert.deepEqual(f.controls.supportedProviders, [config.expected]);
      assert.deepEqual(
        f.views[0].providerSelect.options.map(({ value }) => value),
        [config.expected],
      );
      assert.equal(f.instances.length, 1);
      assert.equal(f.instances[0].provider, config.expected);
      const unsupported = config.expected === 'openai' ? 'gemini' : 'openai';
      assert.equal(f.selectProvider(unsupported), false);
      assert.deepEqual(f.storageWrites, []);
      await f.controls.start();
      assert.deepEqual(f.starts, [config.expected]);
    });
  }
});

test('a host without an available supported factory fails before mounting controls', (t) => {
  assert.throws(
    () =>
      setup(t, {
        supportedProviders: ['gemini'],
        factoryProviders: ['openai'],
      }),
    /No supported voice provider/,
  );
});
