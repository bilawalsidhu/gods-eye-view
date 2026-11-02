import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualVoicePanel } from './manualPanel.js';

function fixture(t) {
  const doc = { activeElement: null };
  const node = () =>
    Object.assign(new EventTarget(), {
      hidden: false,
      isConnected: true,
      dataset: {},
      attributes: {},
      ownerDocument: doc,
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      focus() {
        doc.activeElement = this;
      },
      contains(other) {
        return other === this;
      },
      checkVisibility() {
        return !this.hidden;
      },
    });
  const ui = Object.fromEntries(
    [
      'root',
      'voicePanel',
      'previewPanel',
      'voiceSettingsPanel',
      'previewTab',
      'settingsTab',
      'voiceSettingsButton',
      'voiceSettingsClose',
      'previewEmpty',
      'card',
      'button',
    ].map((key) => [key, node()]),
  );
  ui.voicePanel.contains = (element) =>
    Object.values(ui).includes(element) &&
    ![ui.root, ui.voiceSettingsButton, ui.button].includes(element);
  let enabled = true,
    content = false,
    intents = 0;
  const card = {
    setPresented(value) {
      this.presented = value;
      ui.card.hidden = !(value && enabled && content);
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
  return {
    ui,
    panel,
    doc,
    card,
    copy,
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
const click = (element) => element.dispatchEvent(new Event('click'));
function key(element, value) {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperty(event, 'key', { value });
  element.dispatchEvent(event);
  return event;
}

test('Settings launcher toggles while tab and programmatic selection remain idempotent', (t) => {
  const f = fixture(t);
  assert.equal(f.panel.snapshot().panelOpen, false);
  click(f.ui.voiceSettingsButton);
  assert.equal(f.panel.snapshot().settingsOpen, true);
  assert.equal(f.doc.activeElement, f.ui.settingsTab);
  assert.equal(f.ui.voiceSettingsButton.attributes['aria-expanded'], 'true');
  click(f.ui.voiceSettingsButton);
  assert.equal(f.panel.snapshot().panelOpen, false);
  click(f.ui.settingsTab);
  assert.equal(f.panel.snapshot().settingsOpen, true);
  assert.equal(f.panel.select('settings').changed, false);
  assert.equal(f.panel.snapshot().settingsOpen, true);
  click(f.ui.settingsTab);
  assert.equal(f.panel.snapshot().settingsOpen, true);
  assert.equal(f.panel.select('unknown').reason, 'unknown-view');
});

test('tab keyboard navigation and Escape preserve focus and accessibility state', (t) => {
  const f = fixture(t);
  click(f.ui.voiceSettingsButton);
  assert.equal(key(f.ui.settingsTab, 'ArrowLeft').defaultPrevented, true);
  assert.equal(f.panel.snapshot().view, 'preview');
  assert.equal(f.doc.activeElement, f.ui.previewTab);
  assert.equal(f.ui.previewTab.tabIndex, 0);
  assert.equal(f.ui.settingsTab.tabIndex, -1);
  assert.equal(f.ui.previewTab.attributes['aria-selected'], 'true');
  key(f.ui.previewTab, 'End');
  assert.equal(f.panel.snapshot().view, 'settings');
  key(f.ui.settingsTab, 'Home');
  assert.equal(f.panel.snapshot().view, 'preview');
  assert.equal(key(f.ui.voicePanel, 'Escape').defaultPrevented, true);
  assert.equal(f.panel.snapshot().panelOpen, false);
  assert.equal(f.doc.activeElement, f.ui.voiceSettingsButton);
  assert.equal(key(f.ui.voicePanel, 'Escape').defaultPrevented, false);
});

test('manual switching transfers hidden-panel focus without stealing unrelated focus', (t) => {
  const f = fixture(t);
  f.panel.select('settings');
  f.ui.voiceSettingsPanel.focus();
  f.panel.select('preview');
  assert.equal(f.doc.activeElement, f.ui.previewTab);
  const unrelated = (f.doc.activeElement = {});
  f.panel.select('settings');
  assert.equal(f.doc.activeElement, unrelated);
  assert.equal(f.panel.close('preview').changed, false);
  assert.equal(f.panel.snapshot().settingsOpen, true);
});

test('manual Preview selection never enables a disabled preference and uses injected copy', (t) => {
  const f = fixture(t);
  f.enabled(false);
  f.content(true);
  f.panel.select('preview');
  assert.equal(f.panel.snapshot().previewEnabled, false);
  assert.equal(f.panel.snapshot().previewVisible, false);
  assert.equal(f.ui.previewEmpty.textContent, f.copy.previewDisabled);
  assert.equal(f.ui.previewEmpty.hidden, false);
  f.enabled(true);
  assert.equal(f.panel.snapshot().previewVisible, true);
  assert.equal(f.ui.previewEmpty.hidden, true);
  f.content(false);
  assert.equal(f.ui.previewEmpty.textContent, f.copy.previewEmpty);
});

test('disposal hides owned presentation and removes listeners without destroying the card', (t) => {
  const f = fixture(t);
  f.panel.select('settings');
  const count = f.intents();
  f.panel.destroy();
  f.panel.destroy();
  click(f.ui.voiceSettingsButton);
  click(f.ui.settingsTab);
  assert.equal(f.intents(), count);
  assert.equal(f.ui.voicePanel.hidden, true);
  assert.equal(f.card.presented, false);
  assert.equal(f.panel.select('preview').reason, 'disposed');
  assert.equal(f.panel.close().reason, 'disposed');
});

test('pointer grace expires, resets on reentry, ignores touch and clears on disposal', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const pointer = (type, pointerType = 'mouse') => {
    const event = new Event(type);
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    f.ui.root.dispatchEvent(event);
  };
  pointer('pointerleave');
  t.mock.timers.tick(699);
  assert.equal(f.ui.root.dataset.rowGrace, 'true');
  pointer('pointerenter');
  assert.equal(f.ui.root.dataset.rowGrace, undefined);
  pointer('pointerleave');
  t.mock.timers.tick(699);
  assert.equal(f.ui.root.dataset.rowGrace, 'true');
  t.mock.timers.tick(1);
  assert.equal(f.ui.root.dataset.rowGrace, undefined);
  pointer('pointerleave', 'touch');
  assert.equal(f.ui.root.dataset.rowGrace, undefined);
  pointer('pointerleave');
  f.panel.destroy();
  assert.equal(f.ui.root.dataset.rowGrace, undefined);
  pointer('pointerleave');
  t.mock.timers.tick(700);
  assert.equal(f.ui.root.dataset.rowGrace, undefined);
});
