import test from 'node:test';
import assert from 'node:assert/strict';
import { bindChatPreferences } from './chatPreferences.js';
import { createTestVoiceUi } from '../testSupport/voiceUi.mjs';

// A draft field with a caret, as the chat input exposes it to the owner.
function chatInput(t) {
  const field = { value: '', selectionStart: 0, selectionEnd: 0 };
  const prefs = bindChatPreferences({
    ui: createTestVoiceUi(),
    getDraft: () => field.value,
    setDraft: (text, { caret = text.length } = {}) => {
      field.value = text;
      field.selectionStart = field.selectionEnd = caret;
    },
  });
  t.after(() => prefs.destroy());
  const press = (key, init = {}) => {
    const event = {
      key,
      target: field,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...init,
    };
    return { used: prefs.keydown(event), event };
  };
  const type = (text, caret = text.length) => {
    field.value = text;
    field.selectionStart = field.selectionEnd = caret;
  };
  return { field, prefs, press, type };
}

test('Up and Down step through sent messages and restore the unsent draft', (t) => {
  const { field, prefs, press, type } = chatInput(t);
  for (const text of ['Fly to Tokyo', 'Show live flights', 'Show earthquakes'])
    prefs.remember(text);
  type('Reset', 0);
  for (const expected of [
    'Show earthquakes',
    'Show live flights',
    'Fly to Tokyo',
    'Fly to Tokyo',
  ]) {
    const { used, event } = press('ArrowUp');
    assert.equal(used, true);
    assert.equal(event.defaultPrevented, true);
    assert.equal(field.value, expected);
    assert.equal(field.selectionStart, 0);
  }
  for (const expected of ['Show live flights', 'Show earthquakes']) {
    assert.equal(press('ArrowDown').used, true);
    assert.equal(field.value, expected);
  }
  // Past the newest message, Down puts back what was being typed.
  assert.equal(press('ArrowDown').used, true);
  assert.equal(field.value, 'Reset');
  assert.equal(field.selectionStart, 'Reset'.length);
  // With no recalled message, Down stays native.
  type('Reset', 0);
  assert.equal(press('ArrowDown').used, false);
});

test('arrow keys stay native away from the start, with modifiers or a selection', (t) => {
  const { field, prefs, press, type } = chatInput(t);
  assert.equal(press('ArrowUp').used, false, 'nothing sent yet');
  prefs.remember('Fly to Tokyo');
  type('Show', 2);
  assert.equal(press('ArrowUp').used, false, 'caret inside the text');
  type('Show', 0);
  for (const init of [
    { shiftKey: true },
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { isComposing: true },
  ])
    assert.equal(press('ArrowUp', init).used, false, JSON.stringify(init));
  field.selectionEnd = 2;
  assert.equal(press('ArrowUp').used, false, 'text selected');
  assert.equal(field.value, 'Show');
});

test('editing a recalled message ends recall, and sending resets it', (t) => {
  const { field, prefs, press, type } = chatInput(t);
  prefs.remember('Fly to Tokyo');
  prefs.remember('Show live flights');
  press('ArrowUp');
  assert.equal(field.value, 'Show live flights');
  // An edit makes the text a new draft; Down no longer recalls.
  type('Show live flights now', 0);
  prefs.render();
  assert.equal(press('ArrowDown').used, false);
  prefs.remember('Show live flights now');
  type('', 0);
  press('ArrowUp');
  assert.equal(field.value, 'Show live flights now');
});
