import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceCommands } from './commands.js';
import { createVoiceUserTurnTracker } from './userTurnIntent.js';
import { createGevActionRunner } from './gevActions.js';

function element(properties = {}) {
  const target = new EventTarget();
  Object.assign(target, properties);
  target.setAttribute = () => {};
  return target;
}

function fixture(
  t,
  {
    callback = false,
    field = true,
    select = true,
    providers = ['openai', 'gemini'],
    runner,
  } = {},
) {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  const ui = {
    root: { dataset: {}, remove() {} },
    button: element(),
    status: {},
    detail: {},
    ...(field ? { providerField: { hidden: true } } : {}),
    ...(select
      ? {
          providerSelect: element({
            options: providers.map((value) => ({ value })),
            ownerDocument: { createElement: () => ({}) },
            replaceChildren(...options) {
              this.options = options;
            },
          }),
        }
      : {}),
  };
  const calls = [];
  let hooks;
  const controls = createVoiceCommands({
    resetExisting: false,
    createControl: () => ui,
    supportedProviders: providers,
    ...(callback ? { onProviderChange() {} } : {}),
    runner: async (name, args, options) => {
      calls.push({ name, args, options });
      return runner ? runner(name, args, options) : { ok: true };
    },
    createSession(options) {
      hooks = options;
      return {
        start() {
          hooks.emit({ type: 'state', state: 'listening' });
        },
        stop() {},
        sendText() {},
        sendMapEvent() {},
      };
    },
  });
  t.after(() => {
    controls.session.destroy();
    globalThis.window = previous;
  });
  return { controls, ui, calls, hooks };
}

test('command hosts grant provider chooser guidance only with a callback and actual controls', async (t) => {
  for (const [options, expected] of [
    [{}, false],
    [{ callback: true }, true],
    [{ callback: true, field: false }, false],
    [{ callback: true, select: false }, false],
  ]) {
    await t.test(JSON.stringify(options), async (t) => {
      const f = fixture(t, options);
      await f.controls.session.start();
      await f.hooks.runAction(
        'fly_to_location',
        { query: 'London' },
        {
          providerDropdown: !expected,
        },
      );
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].options.providerDropdown, expected);
      if (f.ui.providerField)
        assert.equal(f.ui.providerField.hidden, !expected);
    });
  }
});

test('single-provider hosts hide an unusable chooser and give neutral actual runner guidance', async (t) => {
  for (const providers of [['openai'], ['gemini'], ['openai', 'openai']]) {
    const f = fixture(t, {
      callback: true,
      providers,
      runner: createGevActionRunner({
        viewer: {
          clock: { onTick: { addEventListener: () => () => {} } },
          camera: { moveEnd: { addEventListener() {} } },
          scene: {
            canvas: { addEventListener() {}, removeEventListener() {} },
          },
        },
        styleManager: {},
      }),
    });
    const tracker = createVoiceUserTurnTracker();
    tracker.text('switch voice provider to Gemini');
    tracker.expectResponse();
    tracker.bindResponse('request');
    await f.controls.session.start();
    const result = await f.hooks.runAction(
      'set_panel_open',
      { panelId: 'radio-panel', open: true },
      { userTurn: tracker.forResponse('request'), providerDropdown: true },
    );
    assert.equal(f.ui.providerField.hidden, true);
    assert.equal(f.calls[0].options.providerDropdown, false);
    assert.equal(result.providerRequestBlocked, true);
    assert.doesNotMatch(result.say, /dropdown/);
  }
});

test('disabled or hidden selectors cannot grant chooser guidance despite usable options', async (t) => {
  const f = fixture(t, { callback: true });
  await f.controls.session.start();
  await f.hooks.runAction('get_current_view_state', {});
  f.ui.providerSelect.disabled = true;
  await f.hooks.runAction(
    'get_current_view_state',
    {},
    { providerDropdown: true },
  );
  f.ui.providerSelect.disabled = false;
  f.ui.providerSelect.hidden = true;
  await f.hooks.runAction(
    'get_current_view_state',
    {},
    { providerDropdown: true },
  );
  f.ui.providerSelect.hidden = false;
  await f.hooks.runAction('get_current_view_state', {});
  assert.deepEqual(
    f.calls.map(({ options }) => options.providerDropdown),
    [true, false, false, true],
  );
});

test('command hosts refresh chooser availability when the actual field is hidden', async (t) => {
  const f = fixture(t, { callback: true });
  await f.controls.session.start();
  await f.hooks.runAction('get_current_view_state', {});
  f.ui.providerField.hidden = true;
  await f.hooks.runAction('get_current_view_state', {});
  f.ui.providerField.hidden = false;
  await f.hooks.runAction('get_current_view_state', {});
  assert.deepEqual(
    f.calls.map(({ options }) => options.providerDropdown),
    [true, false, true],
  );
});

test('a disabled alternate option does not grant chooser guidance', async (t) => {
  const f = fixture(t, { callback: true });
  await f.controls.session.start();
  f.ui.providerSelect.options[1].disabled = true;
  await f.hooks.runAction(
    'get_current_view_state',
    {},
    { providerDropdown: true },
  );
  f.ui.providerSelect.options[1].disabled = false;
  await f.hooks.runAction('get_current_view_state', {});
  assert.deepEqual(
    f.calls.map(({ options }) => options.providerDropdown),
    [false, true],
  );
});

test('adapter-side provider refusal reads current usable host chooser capability', async (t) => {
  const f = fixture(t, { callback: true });
  assert.equal(typeof f.hooks.providerDropdown, 'function');
  assert.equal(f.hooks.providerDropdown(), true);
  f.ui.providerSelect.options[1].disabled = true;
  assert.equal(f.hooks.providerDropdown(), false);
  f.ui.providerSelect.options[1].disabled = false;
  f.ui.providerField.hidden = true;
  assert.equal(f.hooks.providerDropdown(), false);
  f.ui.providerField.hidden = false;
  assert.equal(f.hooks.providerDropdown(), true);
});
