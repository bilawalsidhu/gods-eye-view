// Imports intentionally target the candidate, never the immutable reference.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderCommands,
  readVoiceProvider,
} from './providerCommands.js';
import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createVoiceCommands as createCommands } from './commands.js';
import { createGevActionRunner } from './gevActions.js';
import { createPointerTracker } from './pointerContext.js';
import { createReferentRegistry } from './referents.js';
import { describeUnsavedWork, t as translate } from '../i18n/index.js';

const PROVIDER_KEY = 'gev.voice.provider';
const settle = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Listener counts observe the actual binder's registrations/removals.
class Element extends EventTarget {
  listeners = new Map();
  attributes = new Map();
  addEventListener(type, handler, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
    super.addEventListener(type, handler, options);
  }
  removeEventListener(type, handler, options) {
    this.listeners.get(type)?.delete(handler);
    super.removeEventListener(type, handler, options);
  }
  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  focus() {
    this.focusCount = (this.focusCount || 0) + 1;
  }
}

for (const custom of [false, true]) {
  test(`public composition preserves the ${custom ? 'custom adapter' : 'default OpenAI adapter'} path`, async (t) => {
    const prior = globalThis.window;
    globalThis.window = new EventTarget();
    let controls;
    t.after(() => {
      controls?.session.destroy();
      globalThis.window = prior;
    });
    const ui = {
      root: { dataset: {}, remove() {} },
      button: new Element(),
      status: {},
      detail: {},
      providerField: {},
    };
    let defaultCreated = 0;
    let customCreated = 0;
    const options = {
      runner: async () => ({ ok: true }),
      createControl: () => ui,
      createController: ({ onSessionEvent }) => {
        defaultCreated++;
        return {
          ui,
          start({ pushToTalk }) {
            this.pushToTalkMode = pushToTalk;
            onSessionEvent({ type: 'state', state: 'listening' });
          },
          stop() {},
          syncCostUi() {},
          bindPushToTalkShortcut() {},
          sendTextCommand: (text) => `default:${text}`,
        };
      },
    };
    if (custom) {
      options.supportedProviders = ['gemini'];
      options.createSession = ({ emit }) => {
        customCreated++;
        return {
          capabilities: { pushToTalk: false },
          start() {
            emit({ type: 'state', state: 'listening' });
          },
          stop() {},
          sendText: (text) => `custom:${text}`,
          sendMapEvent: () => true,
        };
      };
    }
    controls = createCommands(options);
    await controls.session.start({ pushToTalk: true });
    assert.equal(defaultCreated, custom ? 0 : 1);
    assert.equal(customCreated, custom ? 1 : 0);
    assert.equal(
      controls.session.sendText('test'),
      `${custom ? 'custom' : 'default'}:test`,
    );
    assert.equal(ui.providerField.hidden, true);
    assert.equal(ui.root.dataset.providerChoice, 'false');
    if (!custom)
      assert.deepEqual(controls.session.adapter.getStartOptions(), {
        pushToTalk: true,
      });
  });
}

/** Real facade -> real binder -> real common session and real action runner.
 * Adapters and passive UI/viewer boundaries are fixtures. Wrappers only count
 * calls to real pointer/referent/conversation cleanup; they do not replace it.
 */
function compositionFixture(
  t,
  {
    supportedProviders = ['openai', 'gemini'],
    factoryProviders = ['openai', 'gemini'],
    savedProvider = null,
    storageDenied = false,
    gateStarts = () => false,
    onSessionEvent = () => {},
  } = {},
) {
  const original = new Map(
    ['window', 'document'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const lifetime = new AbortController();
  const views = [];
  const instances = [];
  const mounts = [];
  const events = [];
  const order = [];
  const annotations = new Set();
  const storageWrites = [];
  const counters = { pointer: 0, referents: 0, conversation: 0, dispose: 0 };
  const state = { height: 1000, zooms: 0, renders: 0 };
  let facade;
  let pointer;
  globalThis.window = new EventTarget();
  globalThis.document = {
    getElementById: (id) =>
      id === 'gev-voice-provider' ? views.at(-1)?.providerSelect : null,
  };
  t.after(async () => {
    try {
      facade?.destroy();
      pointer?.destroy();
      for (const instance of instances)
        for (const gate of instance.gates) gate.resolve();
      await Promise.allSettled(instances.flatMap((instance) => instance.jobs));
    } finally {
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });

  const canvas = new EventTarget();
  Object.assign(canvas, { clientWidth: 800, clientHeight: 600 });
  const position = { x: 6379137, y: 0, z: 0 };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    camera: {
      positionWC: position,
      positionCartographic: { height: state.height },
      moveEnd: { addEventListener() {} },
      cancelFlight() {},
      zoomIn(metres) {
        position.x -= metres;
        state.height -= metres;
        this.positionCartographic.height = state.height;
        state.zooms++;
      },
      zoomOut(metres) {
        position.x += metres;
        state.height += metres;
        this.positionCartographic.height = state.height;
        state.zooms++;
      },
    },
    scene: {
      canvas,
      requestRender() {
        state.renders++;
      },
    },
  };
  const dataManager = { layers: new Map() };
  pointer = createPointerTracker({ element: null, now: () => 1000 });
  const referents = createReferentRegistry();
  const runner = createGevActionRunner({
    viewer,
    dataManager,
    styleManager: {},
    deixis: { pointer, referents },
  });
  for (const [object, method, counter] of [
    [pointer, 'clear', 'pointer'],
    [referents, 'clear', 'referents'],
    [runner, 'resetConversation', 'conversation'],
    [runner, 'dispose', 'dispose'],
  ]) {
    const originalMethod = object[method];
    object[method] = (...args) => {
      counters[counter]++;
      order.push(counter);
      return originalMethod.apply(object, args);
    };
  }

  const factories = Object.fromEntries(
    factoryProviders.map((provider) => [
      provider,
      (hooks) => {
        const id = instances.length;
        let generation = 0;
        const instance = {
          id,
          provider,
          hooks,
          starts: [],
          stops: [],
          jobs: [],
          gates: [],
          acquired: 0,
          microphoneEnabled: false,
          bound: 0,
          input: { pushToTalk: false, held: false },
          texts: [],
          mapEvents: [],
        };
        instances.push(instance);
        order.push(`factory:${id}`);
        const adapter = {
          identity: `${provider}:${id}`,
          capabilities: {
            pushToTalk: true,
            costControls: provider === 'openai',
          },
          controller: {
            providerDiagnostic() {
              return this.session.adapter.identity;
            },
          },
          start(settings = {}) {
            const attempt = ++generation;
            instance.starts.push({ ...settings });
            instance.input.pushToTalk = Boolean(settings.pushToTalk);
            hooks.emit({
              type: 'state',
              state: 'connecting',
              detail: `adapter:${provider}`,
            });
            const job = (async () => {
              if (attempt !== generation || hooks.signal.aborted) return;
              if (gateStarts(instance)) {
                const gate = deferred();
                instance.gates.push(gate);
                await gate.promise;
              }
              // Adapters own cancellation of their asynchronous acquisition.
              if (attempt !== generation || hooks.signal.aborted) return;
              instance.acquired++;
              instance.microphoneEnabled =
                !instance.input.pushToTalk || instance.input.held;
              hooks.emit({
                type: 'state',
                state: 'listening',
                detail: provider,
              });
            })();
            instance.jobs.push(job);
            return job;
          },
          stop(settings = {}) {
            generation++;
            instance.stops.push({ ...settings });
            order.push(`stop:${id}`);
            instance.input.pushToTalk = instance.input.held = false;
            instance.microphoneEnabled = false;
          },
          getStartOptions: () => ({ pushToTalk: instance.input.pushToTalk }),
          bindControls() {
            instance.bound++;
          },
          sendText(text) {
            instance.texts.push(text);
            return `${provider}:${text}`;
          },
          sendMapEvent(event) {
            instance.mapEvents.push(event);
            return true;
          },
        };
        instance.adapter = adapter;
        return adapter;
      },
    ]),
  );

  function createControl() {
    const id = views.length;
    order.push(`control:${id}`);
    const providerSelect = new Element();
    providerSelect.ownerDocument = { createElement: () => ({}) };
    providerSelect.replaceChildren = (...options) => {
      providerSelect.options = options;
    };
    const view = {
      root: {
        dataset: {},
        classList: { remove() {} },
        removeCount: 0,
        remove() {
          this.removeCount++;
          order.push(`remove:${id}`);
        },
      },
      button: new Element(),
      providerSelect,
      providerField: {},
      status: {},
      detail: {},
      errorDetail: {},
      tierButton: {},
      costValue: {},
      helpDetail: {},
      card: {},
    };
    views.push(view);
    return view;
  }
  function passiveView() {
    return {
      events: [],
      outlines: [],
      destroyed: 0,
      handle(event) {
        this.events.push(event);
      },
      outline(event) {
        this.outlines.push(event);
      },
      destroy() {
        this.destroyed++;
      },
    };
  }

  facade = createProviderCommands(
    {
      runner,
      pointer,
      referents,
      dataManager,
      signal: lifetime.signal,
      supportedProviders,
      createControl,
      createCard() {
        const card = passiveView();
        views.at(-1).cardView = card;
        return card;
      },
      createReticle() {
        const reticle = passiveView();
        views.at(-1).reticle = reticle;
        return reticle;
      },
      annotations: {
        onOutlineEvent(callback) {
          annotations.add(callback);
          return () => annotations.delete(callback);
        },
      },
      onSessionEvent(event) {
        events.push(event);
        onSessionEvent(event, facade);
      },
    },
    {
      factories,
      storage: {
        getItem() {
          if (storageDenied) throw Error('Storage denied');
          return savedProvider;
        },
        setItem(key, value) {
          if (storageDenied) throw Error('Storage denied');
          storageWrites.push([key, value]);
          savedProvider = value;
        },
      },
      bind(options) {
        // Keep the real callback so stale-event suppression tests exercise the
        // facade's mount generation as well as the common session's disposal.
        const mount = { options, callback: options.onSessionEvent };
        mounts.push(mount);
        mount.controls = bindVoiceCommands(options);
        return mount.controls;
      },
    },
  );
  return {
    facade,
    runner,
    pointer,
    referents,
    lifetime,
    instances,
    views,
    mounts,
    events,
    order,
    annotations,
    counters,
    storageWrites,
    state,
    select(provider) {
      const select = views.at(-1).providerSelect;
      select.value = provider;
      select.dispatchEvent(new Event('change'));
    },
    seedConversation() {
      pointer.beginTurn('text', {
        capturedSnapshot: { fresh: true, at: 'text' },
      });
      referents.recordResult('frame_overhead', {
        ok: true,
        display: { title: 'One aircraft' },
        referents: [
          { n: 1, id: 'aaa111', label: 'Fixture', layerId: 'flights' },
        ],
      });
      assert.ok(pointer.activeSnapshot());
      assert.equal(referents.list().length, 1);
    },
  };
}

test('provider preference uses only the supplied host capability list', () => {
  const stored = (value) => ({ getItem: () => value });
  assert.equal(readVoiceProvider(stored('gemini'), ['openai']), 'openai');
  assert.equal(readVoiceProvider(stored('openai'), ['gemini']), 'gemini');
  assert.equal(
    readVoiceProvider(stored('unknown'), ['gemini', 'openai']),
    'openai',
  );
  assert.equal(
    readVoiceProvider(stored('gemini'), ['openai', 'gemini']),
    'gemini',
  );
  assert.equal(
    readVoiceProvider(
      {
        getItem() {
          throw Error('denied');
        },
      },
      ['gemini'],
    ),
    'gemini',
  );
});

for (const scenario of [
  {
    title: 'OpenAI-only host ignores saved Gemini',
    requested: ['openai'],
    saved: 'gemini',
    expected: ['openai'],
    provider: 'openai',
  },
  {
    title: 'Gemini-only host falls back from saved OpenAI',
    requested: ['gemini'],
    saved: 'openai',
    expected: ['gemini'],
    provider: 'gemini',
  },
  {
    title: 'dual host restores Gemini',
    requested: ['openai', 'gemini'],
    saved: 'gemini',
    expected: ['openai', 'gemini'],
    provider: 'gemini',
  },
  {
    title: 'unknown, duplicate and unavailable factories are excluded',
    requested: ['unknown', 'gemini', 'openai', 'gemini'],
    factories: ['gemini'],
    saved: 'openai',
    expected: ['gemini'],
    provider: 'gemini',
  },
]) {
  test(scenario.title, (t) => {
    const f = compositionFixture(t, {
      supportedProviders: scenario.requested,
      factoryProviders: scenario.factories,
      savedProvider: scenario.saved,
    });
    assert.deepEqual(f.facade.supportedProviders, scenario.expected);
    assert.equal(Object.isFrozen(f.facade.supportedProviders), true);
    assert.equal(f.facade.provider, scenario.provider);
    assert.deepEqual(
      f.views[0].providerSelect.options.map((option) => option.value),
      scenario.expected,
    );
    assert.equal(
      f.views[0].providerField.hidden,
      scenario.expected.length === 1,
    );
    assert.equal(
      f.views[0].root.dataset.providerChoice,
      String(scenario.expected.length > 1),
    );
    assert.equal(f.instances.length, 1);
    assert.equal(
      f.instances[0].starts.length,
      0,
      'discovery must not start a provider',
    );
    assert.equal(f.facade.state, 'idle');
  });
}

test('invalid or empty host support fails before mounting a control', () => {
  let mounts = 0;
  const dependencies = {
    bind() {
      mounts++;
    },
    factories: { openai() {} },
  };
  assert.throws(
    () =>
      createProviderCommands({ supportedProviders: 'gemini' }, dependencies),
    /must be an array/,
  );
  assert.throws(
    () =>
      createProviderCommands(
        { supportedProviders: ['gemini', 'unknown'] },
        dependencies,
      ),
    /No supported voice provider/,
  );
  assert.equal(mounts, 0);
});

test('active switch keeps PTT mode, retires the held key, and disposes before mounting', async (t) => {
  const f = compositionFixture(t);
  const firstSession = f.facade.session;
  const outerSignal = f.facade.signal;
  const first = f.instances[0];
  // PTT controls can activate the adapter directly; the facade must learn
  // activity from its common events, not only from facade.start().
  first.input.held = true;
  await first.adapter.start({ pushToTalk: true });
  assert.equal(first.microphoneEnabled, true);
  assert.equal(f.facade.isActive(), true);
  f.seedConversation();
  const before = { ...f.counters };
  f.select('gemini');
  await settle();
  const second = f.instances[1];
  assert.equal(window.__gevVoiceCommands, f.facade);
  assert.equal(f.facade.runner, f.runner);
  assert.equal(f.facade.signal, outerSignal);
  assert.equal(outerSignal.aborted, false);
  assert.equal(firstSession.disposed, true);
  assert.equal(first.hooks.signal.aborted, true);
  assert.deepEqual(first.stops, [{ removeUi: true }]);
  assert.equal(first.input.held, false);
  assert.equal(first.microphoneEnabled, false);
  assert.deepEqual(second.starts, [{ pushToTalk: true }]);
  assert.equal(second.input.held, false);
  assert.equal(
    second.microphoneEnabled,
    false,
    'a held key must never migrate to the new adapter',
  );
  assert.equal(f.facade.state, 'listening');
  assert.ok(f.order.indexOf('stop:0') < f.order.indexOf('control:1'));
  assert.ok(f.order.indexOf('remove:0') < f.order.indexOf('control:1'));
  assert.ok(f.order.indexOf('stop:0') < f.order.indexOf('factory:1'));
  assert.equal(f.views[0].button.listenerCount('click'), 0);
  assert.equal(f.views[0].providerSelect.listenerCount('change'), 0);
  assert.equal(f.views[1].providerSelect.listenerCount('change'), 1);
  assert.equal(f.views[1].providerSelect.focusCount, 1);
  assert.equal(f.views[1].tierButton.hidden, true);
  assert.equal(f.views[1].costValue.hidden, true);
  assert.equal(f.facade.providerDiagnostic(), 'gemini:1');
  assert.equal(f.pointer.activeSnapshot(), null);
  assert.deepEqual(f.referents.list(), []);
  for (const key of ['pointer', 'referents', 'conversation'])
    assert.equal(
      f.counters[key],
      before[key] + 1,
      `one explicit replacement reset: ${key}`,
    );
  assert.equal(
    f.counters.dispose,
    0,
    'provider replacement keeps the page runner',
  );
  assert.deepEqual(f.storageWrites, [[PROVIDER_KEY, 'gemini']]);
  assert.equal(f.facade.sendTextCommand('hello'), 'gemini:hello');
  assert.deepEqual(first.texts, []);
  assert.deepEqual(second.texts, ['hello']);
  const result = await f.facade.runner('adjust_camera_zoom', {
    direction: 'in',
    amount: 'little',
  });
  assert.equal(
    result.ok,
    true,
    'the actual shared action runner remains usable after switching',
  );
  assert.equal(f.state.zooms, 1);
});

for (const initialState of ['idle', 'error']) {
  test(`${initialState} selection never autostarts; manual start still works`, async (t) => {
    const f = compositionFixture(t, { storageDenied: true });
    if (initialState === 'error') {
      await f.facade.start({ pushToTalk: true });
      f.instances[0].adapter.stop({ preserveStatus: true });
      f.instances[0].hooks.emit({
        type: 'state',
        state: 'error',
        detail: 'Fixture failure',
      });
    }
    f.select('gemini');
    await settle();
    assert.equal(
      f.facade.provider,
      'gemini',
      'denied storage cannot block a supported selection',
    );
    assert.equal(f.facade.state, 'idle');
    assert.deepEqual(f.instances[1].starts, []);
    f.select('gemini');
    f.select('unknown');
    assert.equal(
      f.instances.length,
      2,
      'same and unsupported selections cannot remount',
    );
    assert.equal(f.facade.provider, 'gemini');
    await f.facade.start({ pushToTalk: false });
    assert.deepEqual(f.instances[1].starts, [{ pushToTalk: false }]);
    assert.equal(f.instances[1].microphoneEnabled, true);
  });
}

for (const outcome of ['resolve', 'reject']) {
  test(`retired startup ${outcome} and stale events cannot affect the current mount`, async (t) => {
    const f = compositionFixture(t, {
      gateStarts: (instance) => instance.id === 0,
    });
    const oldStart = f.facade.start({ pushToTalk: false });
    const old = f.instances[0];
    assert.equal(f.facade.state, 'connecting');
    f.select('gemini');
    await settle();
    assert.equal(f.facade.state, 'listening');
    const current = f.instances[1];
    const eventCount = f.events.length;
    const currentStops = current.stops.length;
    const currentCardCount = f.views[1].cardView.events.length;
    old.gates[0][outcome](new Error('Late retired startup failure'));
    await oldStart;
    for (const state of ['idle', 'error', 'connecting']) {
      old.hooks.emit({ type: 'state', state, detail: 'retired adapter' });
      f.mounts[0].callback({
        type: 'state',
        state,
        detail: 'retired forward callback',
      });
    }
    assert.equal(f.events.length, eventCount);
    assert.equal(f.views[1].cardView.events.length, currentCardCount);
    assert.equal(f.facade.state, 'listening');
    assert.equal(old.acquired, 0);
    assert.equal(current.stops.length, currentStops);
    assert.equal(current.starts.length, 1);
    f.facade.stop();
    f.mounts[0].callback({ type: 'state', state: 'connecting' });
    f.select('openai');
    assert.deepEqual(
      f.instances[2].starts,
      [],
      'a retired connecting callback cannot revive voice intent',
    );
    assert.equal(f.facade.state, 'idle');
  });
}

test('Stop during replacement startup defeats late settlement and further automatic resume', async (t) => {
  const f = compositionFixture(t, {
    gateStarts: (instance) => instance.id === 1,
  });
  await f.facade.start();
  f.select('gemini');
  const replacement = f.instances[1];
  assert.equal(f.facade.state, 'connecting');
  f.facade.stop();
  replacement.gates[0].resolve();
  await Promise.all(replacement.jobs);
  assert.equal(replacement.acquired, 0);
  assert.equal(f.facade.state, 'idle');
  f.select('openai');
  assert.deepEqual(f.instances[2].starts, []);
  await f.facade.start();
  assert.equal(
    f.facade.state,
    'listening',
    'a later explicit start remains healthy',
  );
});

for (const emitsIdle of [false, true]) {
  test(`Stop and error clear pointer/referents/conversation once: adapter emitsIdle=${emitsIdle}`, async (t) => {
    const f = compositionFixture(t);
    if (emitsIdle) {
      const instance = f.instances[0];
      const originalStop = instance.adapter.stop;
      instance.adapter.stop = function (settings = {}) {
        originalStop.call(this, settings);
        if (!settings.preserveStatus && !settings.removeUi)
          instance.hooks.emit({ type: 'state', state: 'idle' });
      };
    }
    for (const end of ['stop', 'error']) {
      await f.facade.start();
      f.seedConversation();
      const before = { ...f.counters };
      const generation = f.referents.generation();
      if (end === 'stop') f.facade.stop();
      else {
        f.instances[0].adapter.stop({ preserveStatus: true });
        f.instances[0].hooks.emit({
          type: 'state',
          state: 'error',
          detail: 'Fixture failure',
        });
      }
      assert.equal(f.pointer.activeSnapshot(), null);
      assert.deepEqual(f.referents.list(), []);
      assert.equal(f.referents.generation(), generation + 1);
      for (const key of ['pointer', 'referents', 'conversation'])
        assert.equal(f.counters[key], before[key] + 1, `${end}: ${key}`);
    }
  });
}

test('outer destruction disposes the runner once and removes each provider binding', async (t) => {
  const priorUnsaved = describeUnsavedWork();
  const f = compositionFixture(t);
  await f.facade.start();
  f.select('gemini');
  await settle();
  assert.equal(f.annotations.size, 1);
  assert.ok(
    describeUnsavedWork().includes(translate('the active voice session')),
  );
  const oldCardEvents = f.views[0].cardView.events.length;
  for (const callback of f.annotations) callback({ id: 'fixture-outline' });
  assert.equal(f.views[0].cardView.outlines.length, 0);
  assert.equal(f.views[1].cardView.outlines.length, 1);
  assert.equal(f.instances[1].mapEvents.length, 1);
  f.facade.destroy();
  f.facade.destroy();
  f.facade.stop({ removeUi: true });
  f.lifetime.abort();
  assert.equal(f.counters.dispose, 1);
  assert.equal(f.facade.signal.aborted, true);
  assert.equal(f.facade.disposed, true);
  assert.equal(f.annotations.size, 0);
  assert.deepEqual(describeUnsavedWork(), priorUnsaved);
  const finalEvents = f.events.length;
  const starts = f.instances.map((instance) => instance.starts.length);
  for (const [index, view] of f.views.entries()) {
    assert.equal(view.root.removeCount, 1);
    assert.equal(view.cardView.destroyed, 1);
    assert.equal(view.reticle.destroyed, 1);
    assert.equal(view.button.listenerCount('click'), 0);
    assert.equal(view.providerSelect.listenerCount('change'), 0);
    assert.equal(f.instances[index].hooks.signal.aborted, true);
    view.button.dispatchEvent(new Event('click'));
    view.providerSelect.value = 'openai';
    view.providerSelect.dispatchEvent(new Event('change'));
    f.instances[index].hooks.emit({ type: 'state', state: 'connecting' });
    f.mounts[index].callback({ type: 'state', state: 'connecting' });
  }
  assert.equal(f.events.length, finalEvents);
  assert.equal(f.views[0].cardView.events.length, oldCardEvents);
  assert.deepEqual(
    f.instances.map((instance) => instance.starts.length),
    starts,
  );
  assert.equal(f.instances.length, 2);
  assert.equal(f.facade.start(), false);
  assert.equal(f.facade.sendText('after destroy'), false);
  assert.equal(f.facade.notifyMapEvent({}), false);
  const result = await f.facade.runner('adjust_camera_zoom', {
    direction: 'in',
    amount: 'little',
  });
  assert.equal(result.cancelled, true);
  assert.equal(
    f.state.zooms,
    0,
    'the actual runner cannot move the camera after outer disposal',
  );
});

for (const action of ['stop', 'destroy']) {
  for (const phase of ['common', 'adapter']) {
    test(`${action} from replacement ${phase} connecting observer prevents resume`, async (t) => {
      let intercepted = 0;
      const f = compositionFixture(t, {
        onSessionEvent(event, facade) {
          if (
            facade?.provider !== 'gemini' ||
            event.type !== 'state' ||
            event.state !== 'connecting'
          )
            return;
          const matching =
            phase === 'common'
              ? event.detail === undefined
              : event.detail === 'adapter:gemini';
          if (matching && intercepted++ === 0) facade[action]();
        },
      });
      await f.facade.start({ pushToTalk: true });
      f.select('gemini');
      await settle();
      const replacement = f.instances[1];
      assert.equal(intercepted, 1);
      assert.equal(replacement.starts.length, phase === 'common' ? 0 : 1);
      assert.equal(replacement.acquired, 0);
      assert.equal(replacement.microphoneEnabled, false);
      assert.equal(f.facade.isActive(), false);
      assert.equal(f.facade.state, 'idle');
      assert.equal(
        f.events.filter(
          (event) => event.state === 'listening' && event.detail === 'gemini',
        ).length,
        0,
      );
      assert.equal(f.facade.disposed, action === 'destroy');
      assert.equal(f.counters.dispose, action === 'destroy' ? 1 : 0);
      if (action === 'stop') {
        f.select('openai');
        assert.deepEqual(
          f.instances[2].starts,
          [],
          'Stop cleared the intent to resume',
        );
        await f.facade.start({ pushToTalk: false });
        assert.equal(f.facade.state, 'listening');
      } else {
        f.select('openai');
        assert.equal(f.instances.length, 2);
        assert.equal(f.facade.start(), false);
      }
    });
  }
}
