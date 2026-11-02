// The language picker switches the page's language in place: the choice is
// stored for the next visit, ?lang leaves the address, onLocaleChange owners
// word their text again and the picker is drawn for the new language.
// Choosing the language already active does nothing.
import { test } from 'node:test';
import { nextTick } from 'vue';
import assert from 'node:assert/strict';
import { StyleManager } from './applicationShell.js';
import { UiLifetime } from './uiLifetime.js';
import { useLocaleStore } from './stores/locale.js';
import { applicationPinia } from './vueRuntime.js';
import { getLocale, onLocaleChange, setLocale } from '../i18n/index.js';

/** Wire the shell's language choice. No picker markup here: the picker's own
 * behaviour is covered by localePicker.test and localePickerView.test. */
function renderSwitch() {
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    localStorage: globalThis.localStorage,
  };
  const reloads = [];
  const addresses = [];
  const stored = [];
  globalThis.document = {
    getElementById: () => null,
    querySelectorAll: () => [],
  };
  globalThis.location = {
    href: 'https://gev.example/?lang=ru#v=2',
    assign: () => reloads.push('assign'),
    reload: () => reloads.push('reload'),
  };
  globalThis.history = {
    replaceState: (_state, _title, href) => addresses.push(href),
  };
  globalThis.localStorage = {
    setItem: (key, value) => stored.push([key, value]),
    getItem: () => null,
  };
  const shell = {
    services: {},
    _lifetime: new UiLifetime(),
    _chooseLocale: StyleManager.prototype._chooseLocale,
    _publishLocalePicker: StyleManager.prototype._publishLocalePicker,
    _sizeDisplayLabelColumn() {},
  };
  StyleManager.prototype._initLocaleSelector.call(shell);
  return {
    choose: (locale) => shell._chooseLocale(locale),
    reloads,
    addresses,
    stored,
    restore() {
      shell._lifetime.destroy();
      useLocaleStore(applicationPinia()).publishPicker(null);
      Object.assign(globalThis, previous);
      setLocale('en');
    },
  };
}

test('another language applies in place, is stored and leaves the address', async () => {
  const view = renderSwitch();
  const heard = [];
  const off = onLocaleChange(() => heard.push(getLocale()));
  try {
    assert.equal(view.choose('es'), 'switched');
    assert.equal(getLocale(), 'es');
    assert.deepEqual(heard, ['es'], 'owners word their text again');
    assert.deepEqual(view.reloads, [], 'no reload');
    assert.equal(view.stored.at(-1)[1], 'es');
    assert.deepEqual(view.addresses, ['https://gev.example/#v=2']);
    const picker = useLocaleStore(applicationPinia()).picker;
    assert.equal(picker.current, 'es');
    assert.equal(picker.focus, true, 'the redrawn picker keeps focus');
    await nextTick();
    assert.equal(
      useLocaleStore(applicationPinia()).picker.focus,
      false,
      'only as it mounts',
    );
  } finally {
    off();
    view.restore();
  }
});

test('the language already active changes nothing', () => {
  const view = renderSwitch();
  try {
    assert.equal(view.choose('en'), 'unchanged');
    assert.deepEqual(view.stored, []);
    assert.deepEqual(view.addresses, []);
    assert.deepEqual(view.reloads, []);
  } finally {
    view.restore();
  }
});

test('a host without Core locales shows no picker; otherwise the shell publishes one', () => {
  const store = useLocaleStore(applicationPinia());
  store.publishPicker(null);
  const disabled = {
    services: {},
    _localePickerEnabled: false,
    _lifetime: new UiLifetime(),
  };
  const chosen = [];
  const enabled = {
    services: {},
    _lifetime: new UiLifetime(),
    _publishLocalePicker: StyleManager.prototype._publishLocalePicker,
    _chooseLocale: (locale) => chosen.push(locale),
  };
  try {
    StyleManager.prototype._initLocaleSelector.call(disabled);
    assert.equal(store.picker, null);
    StyleManager.prototype._initLocaleSelector.call(enabled);
    assert.equal(store.picker.current, 'en');
    assert.equal(store.picker.focus, false);
    store.picker.onSelect('fr');
    assert.deepEqual(chosen, ['fr']);
  } finally {
    store.publishPicker(null);
    disabled._lifetime.destroy();
    enabled._lifetime.destroy();
  }
});
