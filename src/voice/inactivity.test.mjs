import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VOICE_INACTIVITY_MINUTES,
  VOICE_INACTIVITY_NONE_MESSAGE,
  VOICE_INACTIVITY_STORAGE_KEY,
  bindVoiceInactivitySettings,
  createVoiceInactivityController,
  parseVoiceInactivityMinutes,
  readVoiceInactivityMinutes,
  writeVoiceInactivityMinutes,
} from './inactivity.js';
import { createVoiceSession } from './session.js';

function clock() {
  let next = 1;
  const tasks = new Map();
  return {
    setTimer(fn, ms) {
      const id = next++;
      tasks.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      tasks.delete(id);
    },
    latest() {
      return [...tasks.entries()].at(-1);
    },
    fire(id) {
      const task = tasks.get(id);
      tasks.delete(id);
      task?.fn();
    },
    get size() {
      return tasks.size;
    },
  };
}

function timerFixture(minutes = 5) {
  const timers = clock();
  const stops = [];
  const session = {
    active: true,
    isActive() {
      return this.active;
    },
    stop(options) {
      stops.push(options);
      this.active = false;
    },
  };
  const controller = createVoiceInactivityController({
    session,
    minutes,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  controller.handleEvent({ type: 'state', state: 'listening' });
  return { controller, session, stops, timers };
}

test('meaningful transcript activity replaces the inactivity deadline', () => {
  const f = timerFixture(5);
  const [firstId, first] = f.timers.latest();
  assert.equal(first.ms, 5 * 60_000);
  f.controller.handleEvent({
    type: 'transcript',
    role: 'user',
    text: 'show Austin',
  });
  const [secondId] = f.timers.latest();
  assert.notEqual(secondId, firstId);
  f.timers.fire(firstId);
  assert.deepEqual(f.stops, []);
  f.timers.fire(secondId);
  assert.deepEqual(f.stops, [
    { detail: 'Voice paused after 5 minutes of inactivity.' },
  ]);
});

test('speech playback, push-to-talk, and pending tools protect the session', () => {
  const f = timerFixture(3);
  f.controller.handleEvent({
    type: 'activity',
    kind: 'speech-playback',
    active: true,
  });
  assert.equal(f.timers.size, 0);
  f.controller.handleEvent({
    type: 'activity',
    kind: 'push-to-talk',
    active: true,
  });
  f.controller.handleEvent({
    type: 'activity',
    kind: 'speech-playback',
    active: false,
  });
  assert.equal(f.timers.size, 0, 'push-to-talk still owns activity');
  f.controller.handleEvent({
    type: 'activity',
    kind: 'push-to-talk',
    active: false,
  });
  assert.equal(f.timers.size, 1);
  f.controller.handleEvent({ type: 'action-call', name: 'fly_to_location' });
  assert.equal(f.timers.size, 0);
  f.controller.handleEvent({ type: 'action-settled', name: 'fly_to_location' });
  const [deadline] = f.timers.latest();
  f.timers.fire(deadline);
  assert.equal(f.stops.length, 1);
});

test('expiry uses the complete session stop path and preserves its detail', async () => {
  const timers = clock();
  let emit;
  let adapterStops = 0;
  const events = [];
  const session = createVoiceSession({
    runner: async () => ({ ok: true }),
    createAdapter(hooks) {
      emit = hooks.emit;
      return {
        start() {
          emit({ type: 'state', state: 'listening' });
        },
        stop() {
          adapterStops++;
        },
        sendText() {},
        sendMapEvent() {},
      };
    },
  });
  const inactivity = createVoiceInactivityController({
    session,
    minutes: 1,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  session.subscribe((event) => {
    events.push(event);
    inactivity.handleEvent(event);
  });
  await session.start();
  const [deadline] = timers.latest();
  timers.fire(deadline);
  assert.equal(adapterStops, 1);
  assert.equal(session.state, 'idle');
  assert.equal(
    events.at(-1).detail,
    'Voice paused after 1 minute of inactivity.',
  );
  session.destroy();
});

test('current inactivity expiry closes settings, restores focus, and preserves preference', () => {
  const timers = clock();
  const stops = [];
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const session = {
    active: true,
    isActive() {
      return this.active;
    },
    stop(options) {
      stops.push(options);
      this.active = false;
    },
  };
  let settings;
  const controller = createVoiceInactivityController({
    session,
    minutes: 5,
    onExpire: () => settings.setOpen(false),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const ownerDocument = { activeElement: null };
  const focusedControl = element({ value: '5' });
  const panel = element({ hidden: true, ownerDocument });
  panel.contains = (candidate) => candidate === focusedControl;
  const button = element();
  const customInput = element({ value: '5' });
  customInput.setCustomValidity = () => {};
  const options = ['3', '5', '10', '15', 'custom', 'none'].map((value) =>
    element({ value, checked: false }),
  );
  const ui = {
    inactivityOptions: options,
    inactivityCustomRow: { hidden: true },
    inactivityCustomInput: customInput,
    inactivityNote: { textContent: '' },
    voiceSettingsPanel: panel,
    voiceSettingsButton: button,
    voiceSettingsClose: element(),
  };
  settings = bindVoiceInactivitySettings({ ui, storage, controller });
  assert.equal(settings.setPreference(3), true);
  settings.setOpen(true);
  ownerDocument.activeElement = focusedControl;

  controller.handleEvent({ type: 'state', state: 'listening' });
  const [staleDeadline] = timers.latest();
  controller.handleEvent({ type: 'transcript', text: 'still here' });
  const [currentDeadline] = timers.latest();
  timers.fire(staleDeadline);
  assert.equal(
    panel.hidden,
    false,
    'a replaced timer must not close current UI',
  );
  assert.deepEqual(stops, []);

  timers.fire(currentDeadline);
  assert.equal(panel.hidden, true);
  assert.equal(button.attributes['aria-expanded'], 'false');
  assert.equal(button.focused, true);
  assert.equal(values.get(VOICE_INACTIVITY_STORAGE_KEY), '3');
  assert.deepEqual(stops, [
    { detail: 'Voice paused after 3 minutes of inactivity.' },
  ]);
  settings();
});

test('preference parsing and persistence default safely and keep None explicit', () => {
  for (const value of [1, 3, 5, 10, 15, 60])
    assert.equal(parseVoiceInactivityMinutes(value), value);
  for (const value of [0, 61, 2.5, '', '1.5', 'bad'])
    assert.equal(parseVoiceInactivityMinutes(value), undefined);
  assert.equal(parseVoiceInactivityMinutes('none'), null);

  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(
    readVoiceInactivityMinutes(storage),
    DEFAULT_VOICE_INACTIVITY_MINUTES,
  );
  assert.equal(writeVoiceInactivityMinutes(17, storage), true);
  assert.equal(values.get(VOICE_INACTIVITY_STORAGE_KEY), '17');
  assert.equal(readVoiceInactivityMinutes(storage), 17);
  assert.equal(writeVoiceInactivityMinutes(null, storage), true);
  assert.equal(values.get(VOICE_INACTIVITY_STORAGE_KEY), 'none');
  assert.equal(readVoiceInactivityMinutes(storage), null);
  assert.equal(writeVoiceInactivityMinutes(90, storage), false);
  assert.equal(values.get(VOICE_INACTIVITY_STORAGE_KEY), 'none');
});

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

test('custom validation and None copy update only valid local preferences', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const preferences = [];
  const select = element({ value: '' });
  const customInput = element({ value: '5', validityMessage: '' });
  customInput.setCustomValidity = (message) => {
    customInput.validityMessage = message;
  };
  const panel = element({ hidden: true });
  const ui = {
    inactivitySelect: select,
    inactivityCustomRow: { hidden: true },
    inactivityCustomInput: customInput,
    inactivityNote: { textContent: '' },
    voiceSettingsPanel: panel,
    voiceSettingsButton: element(),
    voiceSettingsClose: element(),
  };
  const unbind = bindVoiceInactivitySettings({
    ui,
    storage,
    controller: {
      setPreference(value) {
        preferences.push(value);
      },
      get preference() {
        return preferences.at(-1);
      },
    },
  });
  assert.equal(select.value, '5');
  select.value = 'custom';
  select.dispatchEvent(new Event('change'));
  customInput.value = '0';
  customInput.dispatchEvent(new Event('input'));
  assert.match(customInput.validityMessage, /1 to 60/);
  assert.equal(values.has(VOICE_INACTIVITY_STORAGE_KEY), false);
  customInput.value = '7';
  customInput.dispatchEvent(new Event('input'));
  assert.equal(values.get(VOICE_INACTIVITY_STORAGE_KEY), '7');
  assert.equal(preferences.at(-1), 7);
  select.value = 'none';
  select.dispatchEvent(new Event('change'));
  assert.equal(values.get(VOICE_INACTIVITY_STORAGE_KEY), 'none');
  assert.equal(ui.inactivityNote.textContent, VOICE_INACTIVITY_NONE_MESSAGE);
  unbind();
});

test('choice chips expose Custom as a labeled 1–60 minute slider', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const options = ['3', '5', '10', '15', 'custom', 'none'].map((value) =>
    element({ value, checked: false }),
  );
  const customInput = element({ value: '5' });
  customInput.setCustomValidity = () => {};
  const customValue = { textContent: '' };
  const customRow = { hidden: true };
  const panel = element({ hidden: true });
  const button = element();
  const preferences = [];
  const ui = {
    inactivityOptions: options,
    inactivityCustomRow: customRow,
    inactivityCustomInput: customInput,
    inactivityCustomValue: customValue,
    inactivityNote: { textContent: '' },
    voiceSettingsPanel: panel,
    voiceSettingsButton: button,
    voiceSettingsClose: element(),
  };
  const unbind = bindVoiceInactivitySettings({
    ui,
    storage,
    controller: {
      setPreference(value) {
        preferences.push(value);
      },
      get preference() {
        return preferences.at(-1);
      },
    },
  });

  assert.equal(options.find((option) => option.checked)?.value, '5');
  options.find((option) => option.value === 'custom').checked = true;
  options
    .find((option) => option.value === 'custom')
    .dispatchEvent(new Event('change'));
  assert.equal(customRow.hidden, false);
  assert.match(ui.inactivityNote.textContent, /1 to 60/);

  customInput.value = '17';
  customInput.dispatchEvent(new Event('input'));
  assert.equal(customValue.textContent, '17 min');
  assert.equal(customInput.attributes['aria-valuetext'], '17 minutes');
  assert.equal(values.get(VOICE_INACTIVITY_STORAGE_KEY), '17');
  assert.equal(preferences.at(-1), 17);

  options.find((option) => option.value === 'none').checked = true;
  options
    .find((option) => option.value === 'none')
    .dispatchEvent(new Event('change'));
  assert.equal(customRow.hidden, true);
  assert.equal(ui.inactivityNote.textContent, VOICE_INACTIVITY_NONE_MESSAGE);

  assert.equal(unbind.setPreference(3), true);
  assert.equal(options.find((option) => option.checked)?.value, '3');
  assert.equal(values.get(VOICE_INACTIVITY_STORAGE_KEY), '3');
  assert.equal(unbind.getPreference(), 3);

  assert.equal(unbind.setPreference(23), true);
  assert.equal(options.find((option) => option.checked)?.value, 'custom');
  assert.equal(customInput.value, '23');
  assert.equal(customRow.hidden, false);
  assert.equal(values.get(VOICE_INACTIVITY_STORAGE_KEY), '23');

  assert.equal(unbind.setPreference(null), true);
  assert.equal(options.find((option) => option.checked)?.value, 'none');
  assert.equal(customRow.hidden, true);
  assert.equal(values.get(VOICE_INACTIVITY_STORAGE_KEY), 'none');
  assert.equal(unbind.setPreference(61), false);
  assert.equal(values.get(VOICE_INACTIVITY_STORAGE_KEY), 'none');
  unbind();
});
