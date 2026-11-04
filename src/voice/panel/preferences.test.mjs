import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVoicePreferences,
  bindPreferenceControls,
  VOICE_PREVIEW_STORAGE_KEY as P,
  VOICE_TIMEOUT_STORAGE_KEY as T,
} from './preferences.js';
import { createTestVoiceUi } from '../../testSupport/voiceUi.mjs';

function storage(entries = {}, mode = 'normal') {
  const values = new Map(Object.entries(entries));
  const writes = [];
  return {
    writes,
    values,
    getItem(key) {
      if (mode === 'readthrow') throw Error('blocked');
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      writes.push([key, value]);
      if (mode === 'throw') throw Error('blocked');
      if (mode !== 'noop' && mode !== 'readthrow')
        values.set(key, mode === 'mismatch' ? `${value}!` : value);
    },
  };
}
// A panel control whose timeout field shows `custom` minutes, as a view
// would display before the binder renders.
function controls(custom = '7') {
  const ui = createTestVoiceUi({ panel: true });
  ui.update('preferences', { timeoutMinutes: custom });
  return ui;
}
const fields = (ui) => ui.state.preferences;
const copy = {
  previewNote: 'Preview local',
  timeoutNote: 'Provider limits still apply',
  notSaved: 'Not saved',
};
function bind(ui, preferences, onChange) {
  return bindPreferenceControls({ ui, preferences, copy, onChange });
}

test('defaults and restore are passive; legacy None and stored custom restore', () => {
  for (const [entries, minutes, previewEnabled] of [
    [{}, 5, true],
    [{ [P]: 'false', [T]: 'none' }, 0, false],
    [{ [T]: '17' }, 17, true],
    [{ [T]: 'broken' }, 5, true],
  ]) {
    const disk = storage(entries);
    const prefs = createVoicePreferences({ storage: disk });
    assert.deepEqual(prefs.snapshot(), {
      previewEnabled,
      minutes,
      previewPersisted: null,
      timeoutPersisted: null,
    });
    const ui = controls();
    bind(ui, prefs).dispose();
    assert.deepEqual(disk.writes, []);
  }
});

test('exact valid values, presets, None and serialized readback', () => {
  const disk = storage();
  const prefs = createVoicePreferences({ storage: disk });
  for (const value of [3, 5, 10, 15, '1', '60', 0]) {
    const result = prefs.setMinutes(value);
    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(result.persisted, true);
    assert.equal(result.minutes, Number(value));
    assert.deepEqual(disk.writes.at(-1), [
      T,
      Number(value) === 0 ? 'none' : String(Number(value)),
    ]);
  }
  assert.equal(prefs.setPreviewEnabled(false).previewEnabled, false);
  assert.deepEqual(disk.writes.at(-1), [P, 'false']);
});

test('fractional, malformed, coercible and out-of-range inputs never write or notify', () => {
  const disk = storage();
  const prefs = createVoicePreferences({ storage: disk });
  let notices = 0;
  prefs.subscribe(() => notices++);
  const before = prefs.snapshot();
  for (const value of [
    null,
    undefined,
    true,
    {},
    [],
    '',
    ' ',
    ' 3',
    '3 ',
    '3.0',
    '1e1',
    '0x10',
    'none',
    -1,
    61,
    3.2,
    NaN,
    Infinity,
  ]) {
    const result = prefs.setMinutes(value);
    assert.equal(result.ok, false, String(value));
    assert.equal(result.applied, false);
    assert.equal(result.changed, false);
    assert.deepEqual(prefs.snapshot(), before);
  }
  for (const value of [0, 'true', null])
    assert.equal(prefs.setPreviewEnabled(value).ok, false);
  assert.equal(notices, 0);
  assert.deepEqual(disk.writes, []);
});

for (const mode of ['throw', 'noop', 'mismatch', 'readthrow', 'missing']) {
  test(`storage ${mode} preserves live value and exposes unsaved state across A → B`, () => {
    const disk = mode === 'missing' ? null : storage({}, mode);
    const prefs = createVoicePreferences({ storage: disk });
    const a = controls();
    const bindingA = bind(a, prefs);
    a.emit('preview-change', false);
    a.emit('timeout-select', 'custom');
    a.emit('timeout-input', '19');
    assert.deepEqual(prefs.snapshot(), {
      previewEnabled: false,
      minutes: 19,
      previewPersisted: false,
      timeoutPersisted: false,
    });
    bindingA.dispose();
    const writeCount = disk?.writes.length;
    const b = controls();
    const bindingB = bind(b, prefs);
    assert.equal(fields(b).previewChecked, false);
    assert.equal(fields(b).timeoutMinutes, '19');
    assert.match(fields(b).previewNote, /Not saved/);
    assert.match(fields(b).timeoutNote, /Not saved/);
    assert.equal(disk?.writes.length, writeCount);
    a.emit('preview-change', true);
    a.emit('timeout-select', '3');
    assert.equal(prefs.snapshot().minutes, 19);
    assert.equal(prefs.snapshot().previewEnabled, false);
    bindingB.dispose();
  });
}

test('same-value retry really writes and clears warnings after storage recovers', () => {
  const disk = storage();
  const original = disk.setItem;
  disk.setItem = () => {
    throw Error('blocked');
  };
  const prefs = createVoicePreferences({ storage: disk });
  const ui = controls();
  bind(ui, prefs);
  prefs.setPreviewEnabled(false);
  prefs.setMinutes(12);
  assert.match(fields(ui).timeoutNote, /Not saved/);
  disk.setItem = original;
  const timeout = prefs.setMinutes(12);
  const preview = prefs.setPreviewEnabled(false);
  assert.equal(timeout.changed, false);
  assert.equal(preview.changed, false);
  assert.equal(timeout.persisted, true);
  assert.equal(preview.persisted, true);
  assert.deepEqual(disk.writes, [
    [T, '12'],
    [P, 'false'],
  ]);
  assert.equal(fields(ui).timeoutNote, copy.timeoutNote);
  assert.equal(fields(ui).previewNote, copy.previewNote);
});

test('Custom commits displayed valid value immediately, even when equal to preset', () => {
  const disk = storage();
  const prefs = createVoicePreferences({ storage: disk });
  const ui = controls('10');
  bind(ui, prefs);
  assert.equal(disk.writes.length, 0);
  ui.emit('timeout-select', 'custom');
  assert.equal(prefs.snapshot().minutes, 10);
  assert.equal(fields(ui).timeoutChoice, 'custom');
  assert.equal(fields(ui).timeoutInputHidden, false);
  assert.deepEqual(disk.writes, [[T, '10']]);
  ui.emit('timeout-input', '23');
  ui.emit('timeout-select', '5');
  assert.equal(fields(ui).timeoutMinutes, '23');
  assert.equal(fields(ui).timeoutInputHidden, true);
  ui.emit('timeout-select', 'custom');
  assert.equal(prefs.snapshot().minutes, 23);
  assert.equal(fields(ui).timeoutMinutes, '23');
});

test('invalid control edits restore valid state without writes; None remains distinct', () => {
  const disk = storage({ [T]: '17' });
  const prefs = createVoicePreferences({ storage: disk });
  const ui = controls();
  bind(ui, prefs);
  assert.equal(fields(ui).timeoutMinutes, '17');
  for (const value of ['1.5', '', '61', '0']) {
    // Each refused edit republishes the applied value, so the view writes it
    // back over what was typed.
    const revision = fields(ui).revision;
    ui.emit('timeout-input', value);
    assert.equal(fields(ui).timeoutMinutes, '17');
    assert.ok(fields(ui).revision > revision);
    assert.equal(prefs.snapshot().minutes, 17);
  }
  ui.emit('timeout-select', 'malformed');
  assert.equal(fields(ui).timeoutChoice, 'custom');
  assert.equal(disk.writes.length, 0);
  ui.emit('timeout-select', '0');
  assert.equal(prefs.snapshot().minutes, 0);
  assert.equal(fields(ui).timeoutInputHidden, true);
  // The field shows an invalid value when Custom is chosen.
  ui.update('preferences', { timeoutMinutes: 'bad' });
  ui.emit('timeout-select', 'custom');
  assert.equal(fields(ui).timeoutChoice, '0');
  assert.equal(prefs.snapshot().minutes, 0);
  assert.deepEqual(disk.writes, [[T, 'none']]);
});

test('model snapshots cannot mutate state; unsubscribe and binder disposal release ownership', () => {
  const prefs = createVoicePreferences({ storage: storage() });
  const ui = controls();
  // Count the binder's field listeners still attached.
  const attached = new Set();
  const on = ui.on;
  ui.on = (name, listener) => {
    const off = on(name, listener);
    const entry = { name };
    attached.add(entry);
    return () => {
      attached.delete(entry);
      off();
    };
  };
  let calls = 0;
  const binding = bind(ui, prefs, () => calls++);
  assert.deepEqual([...attached].map((entry) => entry.name).sort(), [
    'preview-change',
    'timeout-input',
    'timeout-select',
  ]);
  const snap = prefs.snapshot();
  snap.minutes = 41;
  assert.equal(prefs.snapshot().minutes, 5);
  const unsub = prefs.subscribe((state) => {
    state.minutes = 22;
  });
  prefs.setMinutes(11);
  assert.equal(calls, 1);
  assert.equal(prefs.snapshot().minutes, 11);
  unsub();
  binding.dispose();
  binding.dispose();
  assert.equal(attached.size, 0);
  prefs.setMinutes(12);
  assert.equal(calls, 1);
  assert.equal(fields(ui).timeoutMinutes, '11');
  // A disposed binder no longer answers its fields.
  ui.emit('timeout-select', '3');
  ui.emit('timeout-input', '9');
  ui.emit('preview-change', false);
  assert.equal(prefs.snapshot().minutes, 12);
  assert.equal(prefs.snapshot().previewEnabled, true);
  assert.equal(fields(ui).timeoutMinutes, '11');
});
