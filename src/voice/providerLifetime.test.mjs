import test from 'node:test';
import assert from 'node:assert/strict';
import { initGevVoiceCommands } from './gevRealtime.js';

test('the composed pointer survives provider replacement and ends with the facade', (t) => {
  const saved = new Map(
    ['window', 'document', 'localStorage'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const window = new EventTarget();
  const document = new EventTarget();
  document.getElementById = () => null;
  Object.assign(globalThis, { window, document });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: null,
  });
  const canvas = new EventTarget();
  Object.assign(canvas, { clientWidth: 400, clientHeight: 300 });
  const viewer = {
    scene: { canvas },
    camera: { moveEnd: { addEventListener: () => () => {} } },
    clock: { onTick: { addEventListener: () => () => {} } },
  };
  const appLifetime = new AbortController();
  const providerSelects = [];
  let commands;
  t.after(() => {
    commands?.destroy();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  commands = initGevVoiceCommands({
    viewer,
    supportedProviders: ['openai', 'gemini'],
    signal: appLifetime.signal,
    createReticle: () => null,
    createControl: () => {
      const button = new EventTarget();
      button.setAttribute = () => {};
      const providerSelect = new EventTarget();
      providerSelect.value = 'openai';
      providerSelect.hidden = false;
      providerSelect.options = [];
      providerSelect.focus = () => {};
      providerSelects.push(providerSelect);
      return {
        root: { dataset: {}, querySelectorAll: () => [], remove() {} },
        button,
        status: {},
        detail: {},
        providerField: { hidden: false, remove() {} },
        providerSelect,
      };
    },
    createController: ({ ui }) => ({
      ui,
      start() {},
      stop() {},
      sendTextCommand() {},
      notifyMapEvent() {},
      syncCostUi() {},
      bindPushToTalkShortcut() {},
    }),
  });
  const pointer = commands.pointer;
  const lifetime = commands.signal;
  pointer.moveTo(50, 50);
  assert.equal(pointer.isFresh(), true);
  for (const provider of ['gemini', 'openai']) {
    const outgoing = commands.session.signal;
    providerSelects.at(-1).value = provider;
    providerSelects.at(-1).dispatchEvent(new Event('change'));
    assert.equal(commands.provider, provider);
    assert.equal(outgoing.aborted, true);
    assert.equal(commands.pointer, pointer);
    assert.equal(commands.signal, lifetime);
    assert.equal(lifetime.aborted, false);
    pointer.moveTo(80, 80);
    assert.equal(
      pointer.isFresh(),
      true,
      `${provider} still receives pointer movement`,
    );
  }
  appLifetime.abort();
  assert.equal(lifetime.aborted, true);
  assert.equal(commands.disposed, true);
  pointer.moveTo(100, 100);
  assert.equal(pointer.isFresh(), false);
});
