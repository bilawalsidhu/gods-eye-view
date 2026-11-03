import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createVoiceControl } from '../control.js';
import { useVoiceStore } from '../../ui/stores/voice.js';
import { createGevActionRunner } from '../gevActions.js';
import { createVoiceCommands as bind } from '../sessionCommands.js';
import { createVoiceCommands as compose } from '../commands.js';
import { createProviderCommands } from '../providerCommands.js';
import { createVoicePanelHost } from './host.js';
import { createTestVoiceUi } from '../../testSupport/voiceUi.mjs';
import { mountVoiceView } from '../../testSupport/voiceView.mjs';

const $ = (selector) => globalThis.document.querySelector(selector);
const exists = (selector) => $(selector) !== null;
const active = () => globalThis.document.activeElement?.id ?? null;
const key = (node, name) =>
  node.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: name,
      bubbles: true,
      cancelable: true,
    }),
  );

function controlledClock() {
  let now = 0,
    next = 0;
  const tasks = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = ++next;
      tasks.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => tasks.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, task] of [...tasks])
        if (task.at <= now && tasks.delete(id)) task.fn();
    },
  };
}

// The custom inactivity minutes, then the select's Custom choice.
function chooseCustomTimeout(ui, minutes) {
  ui.update('preferences', { timeoutMinutes: minutes });
  ui.emit('timeout-select', 'custom');
}

function factory(instances, { stopError = null, native = false } = {}) {
  return (hooks) => {
    const input = {
      pushToTalkKeyHeld: false,
      setMicrophoneEnabled() {},
      releasePushToTalkKey() {
        this.pushToTalkKeyHeld = false;
      },
      resetSession() {},
    };
    const controller = native
      ? {
          input,
          _input: input,
          _turns: { observeSpeech() {} },
          status: 'idle',
          dc: null,
          sendTextCommand(text) {
            if (!text) return false;
            hooks.emit({
              type: 'pointer',
              pointer: { kind: 'here', label: 'Typed target' },
            });
          },
          createAudio(options) {
            this.audioCallbacks = options;
            return {
              pending: false,
              play() {},
              clearPlayback() {},
              close() {},
            };
          },
          handleMessage() {},
          userActivityOpen: false,
          pendingTools: 0,
          isActive: () => true,
        }
      : {};
    const adapter = {
      controller,
      capabilities: { pushToTalk: true },
      starts: 0,
      stops: 0,
      bindControls() {},
      start() {
        this.starts++;
        if (native) {
          hooks.emit({ type: 'state', state: 'connecting' });
          controller.audio = controller.createAudio({ pushToTalk: false });
          hooks.emit({ type: 'state', state: 'connecting' });
          // Native open-mic startup marks presentation pending before speech.
          controller.userTurnPending = true;
        }
        hooks.emit({ type: 'state', state: 'listening' });
      },
      stop() {
        this.stops++;
        if (stopError) throw stopError;
      },
      sendText: () => false,
      sendMapEvent() {},
      getStartOptions: () => ({ pushToTalk: false }),
      hooks,
      input,
    };
    instances.push(adapter);
    return adapter;
  };
}
// With `view`, the real VoiceControl renders the control from its store.
function mounted(t, options = {}) {
  const view = options.view ? mountVoiceView(t) : null;
  const pinia = view?.pinia ?? createPinia();
  const clock = controlledClock();
  const host = createVoicePanelHost({
    storage: options.storage ?? null,
    clock,
    readCockpitState: options.readCockpitState,
  });
  const instances = [];
  const commands = bind({
    runner: options.runner ?? (async () => ({ ok: true })),
    dataManager: { layers: new Map() },
    createSession: factory(instances, options),
    createControl: (control) => createTestVoiceUi({ ...control, pinia }),
    panelHost: host,
    nativePanelProvider: options.native
      ? (options.nativeProvider ?? 'gemini')
      : null,
  });
  t.after(() => {
    try {
      commands.session.destroy();
    } catch {}
    host.destroy();
  });
  return {
    clock,
    host,
    instances,
    commands,
    ui: commands.ui,
    settle: view?.settle,
  };
}

test('actual control default remains opt-out; panel markup has unique controlled panes and an outside alert', async (t) => {
  const view = mountVoiceView(t);
  const store = useVoiceStore(view.pinia);
  const baseline = createVoiceControl({ store });
  t.after(() => baseline.remove());
  assert.equal(baseline.panel, false);
  await view.settle();
  assert.equal(exists('#gev-voice-control'), true);
  assert.equal(exists('#gev-voice-panel'), false);
  const ui = createVoiceControl({ panel: true, store });
  t.after(() => ui.remove());
  await view.settle();
  const panel = $('#gev-voice-panel');
  assert.equal(panel !== null, true);
  assert.equal(
    $('#gev-voice-settings-button').getAttribute('aria-controls'),
    panel.id,
  );
  for (const [tab, pane] of [
    ['#gev-voice-preview-tab', 'gev-voice-preview-panel'],
    ['#gev-voice-settings-tab', 'gev-voice-settings-panel'],
  ]) {
    assert.equal($(tab).getAttribute('aria-controls'), pane);
    assert.equal(exists(`#${pane}`), true);
  }
  assert.equal(
    $('#gev-voice-preview-panel').contains($('#gev-voice-card')),
    true,
  );
  const tray = $('#gev-voice-control .gev-voice-error-tray');
  assert.equal(tray !== null, true);
  assert.equal(panel.contains(tray), false);
  assert.equal(
    $('#gev-voice-control').querySelectorAll('#gev-voice-card').length,
    1,
  );
});

test('actual binder/card has launcher toggle, idempotent tabs, focus and disabled Preview', async (t) => {
  const { ui, commands, settle } = mounted(t, { view: true });
  await settle();
  $('#gev-voice-settings-button').click();
  assert.equal(commands.voicePanel.snapshot().settingsOpen, true);
  $('#gev-voice-settings-button').click();
  assert.equal(commands.voicePanel.snapshot().panelOpen, false);
  await settle();
  $('#gev-voice-settings-tab').click();
  key($('#gev-voice-settings-tab'), 'End');
  assert.equal(commands.voicePanel.snapshot().settingsOpen, true);
  $('#gev-voice-settings-tab').click();
  assert.equal(commands.voicePanel.snapshot().settingsOpen, true);
  commands.voicePanel.select('preview');
  commands.voiceCard.handle({
    type: 'transcript',
    role: 'assistant',
    final: true,
    text: 'A visible reply',
  });
  await settle();
  const dismiss = $('#gev-voice-card-dismiss');
  dismiss.focus();
  dismiss.click();
  await settle();
  assert.equal(ui.state.card.visible, false);
  assert.equal($('#gev-voice-card').hidden, true);
  assert.equal(commands.voicePanel.snapshot().panelOpen, true);
  assert.equal(active(), 'gev-voice-preview-tab');
  key(globalThis.document.activeElement, 'Escape');
  assert.equal(commands.voicePanel.snapshot().panelOpen, false);
  commands.voicePanel.select('settings');
  ui.emit('preview-change', false);
  commands.voicePanel.select('preview');
  commands.voiceCard.handle({
    type: 'transcript',
    role: 'assistant',
    final: true,
    text: 'A hidden reply',
  });
  assert.equal(ui.state.card.visible, false);
  assert.equal(ui.state.previewEmpty.text, 'Preview is off.');
  await settle();
  $('#gev-voice-preview-tab').focus();
  key(globalThis.document.activeElement, 'Escape');
  await settle();
  assert.equal(active(), 'gev-voice-settings-button');
  commands.voiceCard.handle({
    type: 'transcript',
    role: 'assistant',
    final: true,
    text: 'Later reply',
  });
  assert.equal(commands.voicePanel.snapshot().panelOpen, false);
});

test('actual facade remount keeps failed-save live preferences/view and manual close, with no restore writes or focus theft', async (t) => {
  const view = mountVoiceView(t);
  const writes = [];
  const storage = {
    getItem: () => null,
    setItem(key, value) {
      writes.push([key, value]);
      throw Error('blocked');
    },
  };
  const host = createVoicePanelHost({ storage });
  const instances = [];
  const commands = createProviderCommands(
    {
      runner: async () => ({}),
      dataManager: { layers: new Map() },
      supportedProviders: ['openai', 'gemini'],
    },
    {
      bind: (options) =>
        bind({
          ...options,
          panelHost: host,
          createControl: (control) =>
            createTestVoiceUi({ ...control, pinia: view.pinia }),
        }),
      factories: { openai: factory(instances), gemini: factory(instances) },
      storage,
    },
  );
  t.after(() => {
    commands.destroy();
    host.destroy();
  });
  const old = commands.ui;
  commands.voicePanel.select('settings');
  old.emit('preview-change', false);
  chooseCustomTimeout(old, '7');
  const preferenceWrites = () =>
    writes.filter(([key]) => key.startsWith('godsEyeView.voice.')).length;
  assert.equal(preferenceWrites(), 2);
  await view.settle();
  const oldRoot = $('#gev-voice-control');
  old.emit('provider-change', 'gemini');
  assert.equal(commands.ui !== old, true);
  await view.settle();
  assert.equal(oldRoot.isConnected, false);
  assert.equal(commands.voicePanel.snapshot().settingsOpen, true);
  assert.deepEqual(commands.getVoicePreferences(), {
    previewEnabled: false,
    minutes: 7,
    previewPersisted: false,
    timeoutPersisted: false,
  });
  assert.equal(commands.ui.state.preferences.previewChecked, false);
  assert.equal($('#gev-voice-preview-enabled').checked, false);
  assert.match(commands.ui.state.preferences.timeoutNote, /could not be saved/);
  assert.equal(preferenceWrites(), 2);
  assert.equal(active(), 'gev-voice-provider');
  commands.ui.emit('preview-change', true);
  commands.voicePanel.close();
  await commands.start();
  const retired = instances[1];
  commands.ui.emit('provider-change', 'openai');
  await commands.start();
  assert.equal(commands.session.isActive(), true);
  retired.hooks.emit({
    type: 'transcript',
    role: 'assistant',
    text: 'Retired output',
    final: true,
  });
  const emit = instances[2].hooks.emit;
  emit({
    type: 'transcript',
    role: 'assistant',
    text: 'Current output after remount',
    final: true,
  });
  assert.equal(commands.voicePanel.snapshot().panelOpen, false);
  emit({ type: 'interruption', reason: 'user-speech' });
  emit({
    type: 'transcript',
    role: 'assistant',
    text: 'Reply after genuine input',
    final: true,
  });
  assert.equal(commands.voicePanel.snapshot().previewVisible, true);
});

test('explicit successful mic Stop closes; failed Stop idle and startup error do not', async (t) => {
  const good = mounted(t);
  await good.commands.session.start();
  good.commands.voicePanel.select('settings');
  good.ui.emit('button');
  assert.equal(good.commands.voicePanel.snapshot().panelOpen, false);
  const error = Error('stop failed');
  const bad = mounted(t, { stopError: error });
  await bad.commands.session.start();
  bad.commands.voicePanel.select('settings');
  assert.throws(
    () => bad.ui.emit('button'),
    (value) => value === error,
  );
  assert.equal(bad.commands.session.state, 'idle');
  assert.equal(bad.commands.voicePanel.snapshot().settingsOpen, true);
  bad.instances[0].hooks.emit({
    type: 'state',
    state: 'error',
    detail: 'startup failed',
  });
  assert.equal(bad.commands.voicePanel.snapshot().settingsOpen, true);
});

test('reentrant manual choice/new start during Stop cannot close the successor choice', async (t) => {
  const f = mounted(t);
  await f.commands.session.start();
  f.commands.voicePanel.select('settings');
  const unsubscribe = f.commands.session.subscribe((event) => {
    if (event.type === 'state' && event.state === 'idle')
      f.commands.voicePanel.select('preview');
  });
  f.ui.emit('button');
  assert.equal(f.commands.voicePanel.snapshot().panelOpen, true);
  assert.equal(f.commands.voicePanel.snapshot().view, 'preview');
  unsubscribe();
});

test('integrated inactivity rechecks held PTT at expiry, then normal stop closes on later quiet expiry', async (t) => {
  const f = mounted(t, { native: true });
  await f.commands.session.start();
  f.commands.voicePanel.select('settings');
  chooseCustomTimeout(f.ui, '1');
  f.instances[0].input.pushToTalkKeyHeld = true;
  f.clock.advance(60000);
  assert.equal(f.instances[0].stops, 0);
  f.instances[0].input.releasePushToTalkKey();
  f.clock.advance(60000);
  assert.equal(f.instances[0].stops, 1);
  assert.equal(f.commands.voicePanel.snapshot().panelOpen, false);
});

test('None cancels integrated app timer and unknown custom hosts never guess expiry', async (t) => {
  const native = mounted(t, { native: true });
  await native.commands.session.start();
  native.ui.emit('timeout-select', '0');
  native.clock.advance(600000);
  assert.equal(native.instances[0].stops, 0);
  assert.equal(native.commands.getVoicePreferences().minutes, 0);
  const unknown = mounted(t);
  await unknown.commands.session.start();
  unknown.clock.advance(600000);
  assert.equal(unknown.instances[0].stops, 0);
  assert.match(unknown.ui.state.preferences.timeoutStatus, /unavailable/);
});

test('transient native OpenAI response activity does not announce connection unavailability', async (t) => {
  const f = mounted(t, { native: true, nativeProvider: 'openai' });
  await f.commands.session.start();
  chooseCustomTimeout(f.ui, '1');
  f.instances[0].controller._turns.observeSpeech({ type: 'response.created' });
  assert.equal(f.ui.state.preferences.timeoutStatus, '');
  f.clock.advance(60000);
  assert.equal(f.instances[0].stops, 0, 'unknown output still prevents expiry');
  f.instances[0].controller._turns.observeSpeech({
    type: 'output_audio_buffer.cleared',
  });
  f.clock.advance(60000);
  assert.equal(f.instances[0].stops, 1, 'known quiet output permits expiry');
});

test('native factory with custom controller remains uninstrumented despite panel opt-in', (t) => {
  let inspected = 0;
  const commands = compose({
    panel: true,
    panelStorage: null,
    runner: async () => ({}),
    dataManager: { layers: new Map() },
    createController: (options) => ({
      ui: options.ui,
      get _turns() {
        inspected++;
        throw Error('custom internal getter');
      },
      start() {},
      stop() {},
      sendTextCommand() {},
      notifyMapEvent() {},
      syncCostUi() {},
      bindPushToTalkShortcut() {},
      toggleVoiceTier() {},
    }),
  });
  t.after(() => commands.session.destroy());
  assert.equal(inspected, 0);
  assert.equal(commands.getVoicePanelState().activity.known, false);
  assert.equal(inspected, 0);
});

test('native connecting phases retain output observation; idle starts before first speech and waits for drain', async (t) => {
  const f = mounted(t, { native: true });
  await f.commands.session.start();
  const adapter = f.instances[0];
  const controller = adapter.controller;
  assert.equal(
    f.commands.getVoicePanelState().inactivity.eligible,
    true,
    'open microphone presentation-pending is not admitted speech',
  );
  controller.audio.pending = true;
  controller.handleMessage({});
  f.clock.advance(300000);
  assert.equal(adapter.stops, 0);
  assert.equal(f.commands.getVoicePanelState().activity.outputBusy, true);
  controller.audio.pending = false;
  controller.audioCallbacks.onDrain();
  f.clock.advance(300000);
  assert.equal(adapter.stops, 1);
});

async function directActions(
  t,
  { storage = null, delayExit = false, exposePanel = true } = {},
) {
  let f, releaseExit;
  const state = { active: true, exits: 0, visual: [] };
  const styleManager = {
    getCockpitState: () => ({ active: state.active }),
    controlCockpit(action) {
      assert.equal(action, 'exit');
      state.exits++;
      state.active = false;
      const result = { ok: true, state: { active: false } };
      return delayExit
        ? new Promise((resolve) => {
            releaseExit = () => resolve(result);
          })
        : result;
    },
    setPanelCollapsed(...args) {
      state.visual.push(args);
    },
  };
  const runner = createGevActionRunner({
    viewer: {
      clock: { onTick: { addEventListener: () => () => {} } },
      scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
      camera: { moveEnd: { addEventListener() {} } },
    },
    styleManager,
    dataManager: { layers: new Map(), getAll: () => [] },
    readVoicePanelOperation: () =>
      exposePanel ? f?.commands.captureVoicePanelOperation() : undefined,
  });
  f = mounted(t, { native: true, runner, storage });
  await f.commands.session.start();
  return {
    ...f,
    runner,
    state,
    run: f.instances[0].hooks.runAction,
    releaseExit: () => releaseExit(),
  };
}

test('actual runner applies exact timeout directly and reports live-unsaved truth, invalid/cancelled attempts stay inert', async (t) => {
  const f = await directActions(t);
  const result = await f.run('set_voice_inactivity_timeout', { minutes: 7 });
  assert.equal(result.applied, true);
  assert.equal(result.persisted, false);
  assert.equal(result.minutes, 7);
  assert.match(result.say, /could not be saved/);
  assert.equal(f.commands.getVoicePreferences().minutes, 7);
  const invalid = await f.run('set_voice_inactivity_timeout', { minutes: 7.5 });
  assert.equal(invalid.applied, false);
  assert.equal(f.commands.getVoicePreferences().minutes, 7);
  const abort = new AbortController();
  abort.abort();
  const cancelled = await f.runner(
    'set_voice_inactivity_timeout',
    { minutes: 2 },
    { signal: abort.signal },
  );
  assert.equal(cancelled.cancelled, true);
  assert.equal(f.commands.getVoicePreferences().minutes, 7);
  const operation = f.commands.captureVoicePanelOperation();
  f.commands.session.stop();
  assert.equal(operation.setMinutes(2).cancelled, true);
});

test('named voice settings exits Cockpit directly; Preview stays disabled and visual presets stay separate from Scenes', async (t) => {
  const f = await directActions(t);
  const result = await f.run('set_panel_open', {
    panelId: 'voice-settings',
    open: true,
  });
  assert.equal(f.state.exits, 1);
  assert.equal(result.settingsOpen, true);
  f.ui.emit('preview-change', false);
  const preview = await f.run('set_panel_open', {
    panelId: 'voice control',
    open: true,
  });
  assert.equal(preview.view, 'preview');
  assert.equal(preview.previewEnabled, false);
  assert.equal(f.commands.getVoicePreferences().previewEnabled, false);
  for (const panelId of [
    'visual styles',
    'visual preset',
    'visual presets',
    'scenes',
  ])
    await f.run('set_panel_open', { panelId, open: true });
  assert.equal(f.state.exits, 1);
  assert.deepEqual(
    f.state.visual.map(([id]) => id),
    ['control-panel', 'control-panel', 'control-panel', 'scene-panel'],
  );
  await assert.rejects(
    () => f.run('set_panel_open', { panelId: 'settings', open: true }),
    /Unknown panel: settings/,
  );
  assert.equal(
    f.state.visual.length,
    4,
    'an unnamed settings target never guesses a panel',
  );
});

test('canonical exit reveals requested voice UI; newer manual choice or Stop defeats pending reveal', async (t) => {
  const f = await directActions(t, { delayExit: true });
  const pending = f.run('control_cockpit', {
    action: 'exit',
    voicePanel: 'settings',
  });
  f.commands.voicePanel.select('preview');
  f.releaseExit();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(f.state.active, false);
  assert.equal(result.exit.ok, true);
  assert.equal(result.cockpitExited, true);
  assert.match(result.say, /Cockpit exited/);
  assert.equal(f.commands.voicePanel.snapshot().view, 'preview');
  f.state.active = true;
  const alias = f.run('control_cockpit', {
    action: 'leave cockpit',
    voicePanel: 'settings',
  });
  f.releaseExit();
  assert.equal((await alias).settingsOpen, true);
  f.commands.voicePanel.select('preview');
  f.state.active = true;
  const stopped = f.run('control_cockpit', {
    action: 'quit cockpit',
    voicePanel: 'settings',
  });
  f.commands.session.stop();
  f.releaseExit();
  await assert.rejects(stopped, { name: 'AbortError' });
  assert.equal(f.commands.voicePanel.snapshot().view, 'preview');
});

test('unavailable host refuses direct voice operations before Cockpit or preference effects', async (t) => {
  const f = await directActions(t, { exposePanel: false });
  const timeout = await f.run('set_voice_inactivity_timeout', { minutes: 1 });
  assert.equal(timeout.unavailable, true);
  assert.equal(timeout.applied, false);
  const panel = await f.run('set_panel_open', {
    panelId: 'voice-settings',
    open: true,
  });
  assert.equal(panel.unavailable, true);
  assert.equal(f.state.exits, 0);
  assert.equal(f.commands.getVoicePreferences().minutes, 5);
});

test('voice timeout change preserves a pending voice reveal', async (t) => {
  const f = await directActions(t, { delayExit: true });
  const pending = f.run('control_cockpit', {
    action: 'exit',
    voicePanel: 'settings',
  });
  const timeout = await f.run('set_voice_inactivity_timeout', { minutes: 0 });
  assert.equal(timeout.minutes, 0);
  assert.equal(timeout.applied, true);
  f.releaseExit();
  const result = await pending;
  assert.equal(result.settingsOpen, true);
  assert.equal(f.commands.getVoicePreferences().minutes, 0);
});

test('active provider output reveals Preview after done; manual choice wins until genuine input, replays do not reset idle', async (t) => {
  const f = mounted(t, { native: true, nativeProvider: 'openai', view: true });
  await f.commands.session.start();
  const emit = f.instances[0].hooks.emit;
  const reply = (text, responseId = 'r1', extra = {}) =>
    emit({
      type: 'transcript',
      role: 'assistant',
      text,
      responseId,
      final: true,
      ...extra,
    });
  emit({ type: 'completion', responseId: 'r1' });
  reply('Late answer');
  assert.equal(f.commands.voicePanel.snapshot().panelOpen, true);
  const timer = f.commands.voiceCard.hideTimer;
  reply('Late answer');
  reply('Late', 'r1', { final: false });
  assert.equal(f.commands.voiceCard.hideTimer, timer);
  assert.equal(f.commands.voiceCard.state.assistant, 'Late answer');
  f.commands.voicePanel.close();
  emit({
    type: 'transcript',
    role: 'user',
    text: 'advisory caption',
    final: false,
  });
  f.commands.voiceCard.handle({ type: 'dismiss' });
  const advisory = f.commands.voiceCard.state.user;
  emit({
    type: 'interruption',
    reason: 'user-speech',
    preserveAdvisoryCaption: true,
  });
  assert.equal(f.commands.voiceCard.state.dismissed, true);
  assert.equal(f.commands.voiceCard.state.user, advisory);
  reply('Older reply', 'r2');
  assert.equal(f.commands.voicePanel.snapshot().panelOpen, false);
  emit({ type: 'interruption', reason: 'user-speech' });
  reply('A reply with no newest-request attribution', 'older-id');
  assert.equal(f.commands.voicePanel.snapshot().panelOpen, true);
  f.commands.voicePanel.select('settings');
  reply('Another reply', 'r3');
  assert.equal(f.commands.voicePanel.snapshot().settingsOpen, true);
  f.commands.voicePanel.close();
  f.commands.voiceCard.handle({ type: 'dismiss' });
  f.commands.sendTextCommand('Show the typed target');
  reply('Typed reply', 'typed-id');
  assert.equal(f.commands.voicePanel.snapshot().previewVisible, true);
  assert.equal(f.commands.voiceCard.state.dismissed, false);
  assert.equal(f.commands.voiceCard.state.pointer.label, 'Typed target');
  f.commands.session.stop();
  reply('Stopped stale output', 'r4');
  assert.equal(f.commands.voiceCard.state.assistant, null);
  f.commands.session.destroy();
  reply('Disposed stale output', 'r5');
  assert.equal(f.commands.voicePanel.snapshot().panelOpen, false);
});

test('Preview off and actual Cockpit state suppress automatic presentation without enabling preference', async (t) => {
  let cockpit = false;
  const f = mounted(t, {
    native: true,
    view: true,
    readCockpitState: () => ({ active: cockpit }),
  });
  await f.commands.session.start();
  const emit = f.instances[0].hooks.emit;
  const reply = (text) =>
    emit({ type: 'transcript', role: 'assistant', text, final: true });
  reply('Visible');
  await f.settle();
  $('#gev-voice-preview-tab').focus();
  cockpit = true;
  window.dispatchEvent(new Event('gev:cockpit-mode-changed'));
  assert.equal(f.ui.state.voicePanel.hidden, true);
  await f.settle();
  assert.equal(active(), 'gev-voice-settings-button');
  f.commands.voicePanel.select('settings', { focus: true });
  await f.settle();
  assert.equal(active(), 'gev-voice-settings-tab');
  f.commands.voicePanel.select('preview', { focus: true });
  await f.settle();
  assert.equal(active(), 'gev-voice-settings-button');
  const outside = document.createElement('button');
  outside.id = 'unrelated';
  document.body.appendChild(outside);
  outside.focus();
  window.dispatchEvent(new Event('gev:cockpit-mode-changed'));
  await f.settle();
  assert.equal(active(), 'unrelated');
  assert.equal(f.commands.voicePanel.snapshot().previewVisible, false);
  reply('Suppressed in Cockpit');
  assert.equal(f.ui.state.voicePanel.hidden, true);
  f.commands.voicePanel.close();
  cockpit = false;
  window.dispatchEvent(new Event('gev:cockpit-mode-changed'));
  assert.equal(f.ui.state.voicePanel.hidden, true);
  f.ui.emit('preview-change', false);
  emit({ type: 'interruption', reason: 'user-speech' });
  reply('Preference stays off');
  assert.equal(f.ui.state.voicePanel.hidden, true);
  assert.equal(f.commands.getVoicePreferences().previewEnabled, false);
});

test('Provider Settings uses its ready dialog handlers and refuses unavailable or cancelled requests', async (t) => {
  const f = await directActions(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = (open, options) =>
    f.run('set_panel_open', { panelId: 'provider-settings', open }, options);
  assert.equal((await request(true)).unavailable, true);
  const doc = globalThis.document;
  // The setup owner needs only its dialog element; the view is not mounted,
  // so the published dialog state stands in for it.
  const panel = doc.createElement('aside');
  panel.id = 'key-setup';
  doc.body.append(panel);
  const dialog = () => settings.view?.dialog;
  let frames = 0;
  const previousFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    frames++;
    callback();
  };
  t.after(() => {
    if (previousFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousFrame;
  });
  const { initKeySetup } = await import('../../keySetup.js');
  const { useProviderSettingsStore } =
    await import('../../ui/stores/providerSettings.js');
  const { applicationPinia } = await import('../../ui/vueRuntime.js');
  const settings = useProviderSettingsStore(applicationPinia());
  let finishStatus;
  const pending = initKeySetup({
    documentRef: doc,
    fetchImpl: () =>
      new Promise((resolve) => {
        finishStatus = resolve;
      }),
  });
  assert.equal(
    (await request(true)).unavailable,
    true,
    'initializing is not ready',
  );
  finishStatus({
    ok: true,
    json: async () => ({ keys: [], setCount: 0, total: 1 }),
  });
  const setup = await pending;
  t.after(() => setup.destroy());
  doc.body.classList.add('cockpit-mode');
  assert.equal((await request(true)).unavailable, true);
  assert.equal(
    dialog().hidden,
    true,
    'a concealed view cannot schedule a later surprise reveal',
  );
  doc.body.classList.remove('cockpit-mode');
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => request(true, { signal: abort.signal }), {
    name: 'AbortError',
  });
  assert.equal(dialog().hidden, true);
  assert.equal((await request(true)).ok, true);
  assert.equal(dialog().hidden, false);
  assert.equal(dialog().visible, true);
  assert.equal((await request(true)).ok, true);
  assert.equal(frames, 1, 'repeated open reuses the dialog');
  assert.equal((await request(false)).ok, true);
  assert.equal(dialog().visible, false);
  t.mock.timers.tick(400);
  assert.equal(dialog().hidden, true);
  assert.equal((await request(false)).ok, true);
  assert.equal(
    f.state.visual.length,
    0,
    'provider setup never opens a visual or scene panel',
  );
});
