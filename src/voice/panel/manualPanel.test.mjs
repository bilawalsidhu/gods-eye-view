import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualVoicePanel } from './manualPanel.js';
import { createTestVoiceUi } from '../../testSupport/voiceUi.mjs';
import { mountVoiceView } from '../../testSupport/voiceView.mjs';

function fixture(t) {
  const { pinia, settle } = mountVoiceView(t);
  const ui = createTestVoiceUi({ panel: true, pinia });
  t.after(() => ui.remove());
  let enabled = true,
    content = false,
    intents = 0;
  // The card shows when presented, with Preview on and something to show.
  const card = {
    setPresented(value) {
      this.presented = value;
      ui.replace('card', {
        ...ui.state.card,
        visible: Boolean(value && enabled && content),
      });
    },
  };
  const copy = {
    previewEmpty: 'Habla para ver resultados.',
    previewDisabled: 'Vista previa desactivada.',
  };
  const panel = createManualVoicePanel({
    ui,
    card,
    getPreviewEnabled: () => enabled,
    copy,
    onPresentationIntent: () => intents++,
  });
  t.after(() => panel.destroy());
  const $ = (id) => document.getElementById(id);
  return {
    ui,
    panel,
    card,
    copy,
    settle,
    $,
    active: () => document.activeElement?.id ?? null,
    intents: () => intents,
    enabled(value) {
      enabled = value;
      panel.sync();
    },
    content(value) {
      content = value;
      panel.sync();
    },
  };
}
const click = (element) => element.click();
function key(element, value) {
  const event = new KeyboardEvent('keydown', {
    key: value,
    bubbles: true,
    cancelable: true,
  });
  element.dispatchEvent(event);
  return event;
}

test('Settings launcher and tab toggle while programmatic selection stays idempotent', async (t) => {
  const f = fixture(t);
  await f.settle();
  assert.equal(f.panel.snapshot().panelOpen, false);
  click(f.$('gev-voice-settings-button'));
  await f.settle();
  assert.equal(f.panel.snapshot().settingsOpen, true);
  assert.equal(f.active(), 'gev-voice-settings-tab');
  assert.equal(
    f.$('gev-voice-settings-button').getAttribute('aria-expanded'),
    'true',
  );
  click(f.$('gev-voice-settings-button'));
  await f.settle();
  assert.equal(f.panel.snapshot().panelOpen, false);
  click(f.$('gev-voice-settings-tab'));
  assert.equal(f.panel.snapshot().settingsOpen, true);
  assert.equal(f.panel.select('settings').changed, false);
  assert.equal(f.panel.snapshot().settingsOpen, true);
  // Preview has no visible tab, so the Settings tab toggles back to it.
  click(f.$('gev-voice-settings-tab'));
  assert.equal(f.panel.snapshot().view, 'preview');
  assert.equal(f.panel.snapshot().panelOpen, true);
  assert.equal(f.panel.select('unknown').reason, 'unknown-view');
});

test('tab keyboard navigation and Escape preserve focus and accessibility state', async (t) => {
  const f = fixture(t);
  await f.settle();
  click(f.$('gev-voice-settings-button'));
  await f.settle();
  assert.equal(
    key(f.$('gev-voice-settings-tab'), 'ArrowLeft').defaultPrevented,
    true,
  );
  await f.settle();
  assert.equal(f.panel.snapshot().view, 'preview');
  assert.equal(f.active(), 'gev-voice-preview-tab');
  assert.equal(f.$('gev-voice-preview-tab').tabIndex, 0);
  assert.equal(f.$('gev-voice-settings-tab').tabIndex, -1);
  assert.equal(
    f.$('gev-voice-preview-tab').getAttribute('aria-selected'),
    'true',
  );
  key(f.$('gev-voice-preview-tab'), 'End');
  assert.equal(f.panel.snapshot().view, 'settings');
  key(f.$('gev-voice-settings-tab'), 'Home');
  await f.settle();
  assert.equal(f.panel.snapshot().view, 'preview');
  assert.equal(key(f.$('gev-voice-panel'), 'Escape').defaultPrevented, true);
  await f.settle();
  assert.equal(f.panel.snapshot().panelOpen, false);
  // The Settings gear lives in the chat header, so focus returns to Chat.
  assert.equal(f.active(), 'gev-chat-button');
  assert.equal(key(f.$('gev-voice-panel'), 'Escape').defaultPrevented, false);
});

test('manual switching transfers hidden-panel focus without stealing unrelated focus', async (t) => {
  const f = fixture(t);
  f.panel.select('settings');
  await f.settle();
  // Focus inside the Settings pane moves to the Preview tab with the switch.
  f.$('gev-voice-timeout-select').focus();
  f.panel.select('preview');
  await f.settle();
  assert.equal(f.active(), 'gev-voice-preview-tab');
  const unrelated = document.body.appendChild(document.createElement('button'));
  unrelated.id = 'unrelated';
  unrelated.focus();
  f.panel.select('settings');
  await f.settle();
  assert.equal(f.active(), 'unrelated');
  assert.equal(f.panel.close('preview').changed, false);
  assert.equal(f.panel.snapshot().settingsOpen, true);
});

test('manual Preview selection never enables a disabled preference and uses injected copy', async (t) => {
  const f = fixture(t);
  await f.settle();
  f.enabled(false);
  f.content(true);
  f.panel.select('preview');
  await f.settle();
  const empty = f.$('gev-voice-preview-empty');
  assert.equal(f.panel.snapshot().previewEnabled, false);
  assert.equal(f.panel.snapshot().previewVisible, false);
  assert.equal(empty.textContent, f.copy.previewDisabled);
  assert.equal(empty.hidden, false);
  f.enabled(true);
  await f.settle();
  assert.equal(f.panel.snapshot().previewVisible, true);
  assert.equal(empty.hidden, true);
  assert.equal(f.$('gev-voice-card').hidden, false);
  f.content(false);
  await f.settle();
  assert.equal(empty.textContent, f.copy.previewEmpty);
});

test('disposal hides owned presentation and removes listeners without destroying the card', async (t) => {
  const f = fixture(t);
  f.panel.select('settings');
  await f.settle();
  const count = f.intents();
  f.panel.destroy();
  f.panel.destroy();
  click(f.$('gev-voice-settings-button'));
  click(f.$('gev-voice-settings-tab'));
  await f.settle();
  assert.equal(f.intents(), count);
  assert.equal(f.$('gev-voice-panel').hidden, true);
  assert.equal(f.card.presented, false);
  assert.equal(f.panel.select('preview').reason, 'disposed');
  assert.equal(f.panel.close().reason, 'disposed');
});

test('pointer grace expires, resets on reentry, ignores touch and clears on disposal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.settle();
  const root = f.$('gev-voice-control');
  const pointer = (type, pointerType = 'mouse') => {
    const event = new Event(type);
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    root.dispatchEvent(event);
  };
  pointer('pointerleave');
  t.mock.timers.tick(699);
  await f.settle();
  assert.equal(root.dataset.rowGrace, 'true');
  pointer('pointerenter');
  assert.equal(f.ui.state.root.rowGrace ? 'true' : undefined, undefined);
  pointer('pointerleave');
  t.mock.timers.tick(699);
  assert.equal(f.ui.state.root.rowGrace ? 'true' : undefined, 'true');
  t.mock.timers.tick(1);
  assert.equal(f.ui.state.root.rowGrace ? 'true' : undefined, undefined);
  pointer('pointerleave', 'touch');
  assert.equal(f.ui.state.root.rowGrace ? 'true' : undefined, undefined);
  pointer('pointerleave');
  f.panel.destroy();
  assert.equal(f.ui.state.root.rowGrace ? 'true' : undefined, undefined);
  pointer('pointerleave');
  t.mock.timers.tick(700);
  assert.equal(f.ui.state.root.rowGrace ? 'true' : undefined, undefined);
});
