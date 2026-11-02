// src/ui/localePickerView.test.mjs — the language picker renders the
// model in localePicker.js and wires the listbox pattern, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useLocaleStore } from './stores/locale.js';
import ProviderSettingsView from './views/ProviderSettingsView.vue';
import LocalePicker from './views/panels/LocalePicker.vue';

const NAMES = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  'zh-CN': '简体中文',
};

function fixture(t, { searchThreshold = 8 } = {}) {
  document.body.replaceChildren();
  const outside = document.body.appendChild(document.createElement('button'));
  const host = document.body.appendChild(document.createElement('div'));
  const chosen = [];
  // Whether the list was closed on screen when each choice arrived.
  const closedAtChoice = [];
  let picker = null;
  const app = createApp({
    render: () =>
      h(LocalePicker, {
        ref: (instance) => {
          picker = instance;
        },
        current: 'en',
        locales: Object.keys(NAMES),
        nativeNames: NAMES,
        searchThreshold,
        onSelect: (locale) => {
          chosen.push(locale);
          closedAtChoice.push(
            document.getElementById('locale-picker-popup').hidden,
          );
        },
      }),
  });
  app.mount(host);
  let mounted = true;
  const unmount = () => {
    if (mounted) app.unmount();
    mounted = false;
  };
  t.after(unmount);
  const $ = (selector) => document.querySelector(selector);
  const key = (target, init) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  const settle = async () => {
    await nextTick();
    await nextTick();
  };
  return {
    $,
    outside,
    chosen,
    closedAtChoice,
    key,
    settle,
    unmount,
    picker: () => picker,
  };
}

const optionCodes = () =>
  [...document.querySelectorAll('.locale-picker-option')].map(
    (option) => option.dataset.locale,
  );

test('closed, the button names the active language and the list is hidden', (t) => {
  const { $ } = fixture(t);
  const button = $('.locale-picker-button');
  assert.equal(button.getAttribute('aria-label'), 'Language: English');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(button.getAttribute('aria-controls'), 'locale-picker-popup');
  assert.equal($('.locale-picker-code').textContent, 'EN');
  assert.equal($('#locale-picker-popup').hidden, true);
  assert.equal($('#locale-picker').classList.contains('is-open'), false);
  // The current language first, then the rest by their own names.
  assert.deepEqual(optionCodes(), ['en', 'de', 'es', 'fr', 'zh-CN']);
  assert.equal($('[data-locale="en"]').getAttribute('aria-selected'), 'true');
  assert.ok($('[data-locale="en"] .locale-picker-check'));
  assert.equal($('[data-locale="de"] .locale-picker-check'), null);
  const chinese = $('[data-locale="zh-CN"] .locale-picker-option-code');
  assert.equal(chinese.textContent, 'Chinese (Simplified)');
  assert.equal(chinese.lang, 'en');
  assert.equal($('[data-locale="de"] .locale-picker-option-code').lang, '');
  assert.equal($('.locale-picker-search'), null);
});

test('opening focuses the list on the current language; keys move and choose', async (t) => {
  const { $, chosen, key, settle } = fixture(t);
  const button = $('.locale-picker-button');
  button.click();
  await settle();
  const list = $('#locale-picker-listbox');
  assert.equal($('#locale-picker-popup').hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal($('#locale-picker').classList.contains('is-open'), true);
  assert.equal(document.activeElement?.id, 'locale-picker-listbox');
  assert.equal(
    list.getAttribute('aria-activedescendant'),
    'locale-picker-option-en',
  );
  key(list, { key: 'ArrowDown' });
  await settle();
  assert.equal(
    list.getAttribute('aria-activedescendant'),
    'locale-picker-option-de',
  );
  assert.equal($('[data-locale="de"]').classList.contains('is-active'), true);
  assert.equal($('[data-locale="en"]').classList.contains('is-active'), false);
  key(list, { key: 'Enter' });
  await settle();
  assert.deepEqual(chosen, ['de']);
  assert.equal($('#locale-picker-popup').hidden, true);
  assert.equal(document.activeElement === button, true);
});

test('choosing the active language closes without a choice; Escape and outside presses close', async (t) => {
  const { $, chosen, key, outside, settle } = fixture(t);
  const button = $('.locale-picker-button');
  button.click();
  await settle();
  $('[data-locale="en"]').click();
  await settle();
  assert.deepEqual(chosen, []);
  assert.equal($('#locale-picker-popup').hidden, true);

  button.click();
  await settle();
  key(document.body, { key: 'Escape' });
  await settle();
  assert.equal($('#locale-picker-popup').hidden, true);
  assert.equal(document.activeElement === button, true);

  button.click();
  await settle();
  outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await settle();
  assert.equal($('#locale-picker-popup').hidden, true);
});

test('while open, keys typed in the list stay out of the page shortcuts', async (t) => {
  const { $, key, settle } = fixture(t);
  let reached = 0;
  const shortcut = () => reached++;
  document.addEventListener('keydown', shortcut);
  t.after(() => document.removeEventListener('keydown', shortcut));
  $('.locale-picker-button').click();
  await settle();
  key($('#locale-picker-listbox'), { key: 'f' });
  await settle();
  assert.equal(reached, 0);
  assert.equal(
    $('#locale-picker-listbox').getAttribute('aria-activedescendant'),
    'locale-picker-option-fr',
  );
  $('.locale-picker-button').click();
  await settle();
  key(document.body, { key: 'f' });
  assert.equal(reached, 1);
});

test('above the threshold a search field filters the list and owns the active option', async (t) => {
  const { $, chosen, key, settle } = fixture(t, { searchThreshold: 3 });
  $('.locale-picker-button').click();
  await settle();
  const search = $('.locale-picker-search');
  assert.equal(document.activeElement === search, true);
  assert.equal(
    search.getAttribute('aria-activedescendant'),
    'locale-picker-option-en',
  );
  assert.equal(
    $('#locale-picker-listbox').hasAttribute('aria-activedescendant'),
    false,
  );
  search.value = 'espa';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  assert.deepEqual(optionCodes(), ['es']);
  assert.equal($('.locale-picker-empty').hidden, true);
  search.value = 'zzz';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  assert.deepEqual(optionCodes(), []);
  assert.equal($('.locale-picker-empty').hidden, false);
  assert.equal(search.hasAttribute('aria-activedescendant'), false);
  search.value = 'fran';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  key(search, { key: 'Enter' });
  await settle();
  assert.deepEqual(chosen, ['fr']);
  // Reopening starts from an empty search with every language.
  $('.locale-picker-button').click();
  await settle();
  assert.equal($('.locale-picker-search').value, '');
  assert.equal(optionCodes().length, 5);
});

test('focus leaving the picker closes it', async (t) => {
  const { $, outside, picker, settle } = fixture(t);
  $('.locale-picker-button').click();
  await settle();
  $('#locale-picker').dispatchEvent(
    new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }),
  );
  await settle();
  assert.equal($('#locale-picker-popup').hidden, true);
  assert.equal(picker().isOpen(), false);
});

test('a choice arrives after the list is closed on screen', async (t) => {
  const { $, chosen, closedAtChoice, settle } = fixture(t);
  $('.locale-picker-button').click();
  await settle();
  $('[data-locale="fr"]').click();
  await settle();
  assert.deepEqual(chosen, ['fr']);
  assert.deepEqual(closedAtChoice, [true]);
});

test('every opening scrolls the active option into view', async (t) => {
  const { $, settle } = fixture(t);
  const scrolled = [];
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this.dataset.locale);
  };
  t.after(() => {
    HTMLElement.prototype.scrollIntoView = original;
  });
  const button = $('.locale-picker-button');
  button.click();
  await settle();
  button.click();
  await settle();
  button.click();
  await settle();
  assert.deepEqual(scrolled, ['en', 'en']);
});

test('closing or unmounting an open picker releases its page listeners', async (t) => {
  const { $, settle, unmount } = fixture(t);
  const added = [];
  const removed = [];
  const spy = (target, list) => {
    const add = target.addEventListener;
    const remove = target.removeEventListener;
    target.addEventListener = function (type, fn, capture) {
      added.push(type);
      return add.call(this, type, fn, capture);
    };
    target.removeEventListener = function (type, fn, capture) {
      list.push(type);
      return remove.call(this, type, fn, capture);
    };
    t.after(() => {
      target.addEventListener = add;
      target.removeEventListener = remove;
    });
  };
  spy(globalThis, removed);
  spy(document, removed);
  $('.locale-picker-button').click();
  await settle();
  assert.deepEqual(added.sort(), ['keydown', 'pointerdown']);
  $('.locale-picker-button').click();
  await settle();
  assert.deepEqual(removed.sort(), ['keydown', 'pointerdown']);
  removed.length = 0;
  $('.locale-picker-button').click();
  await settle();
  unmount();
  assert.deepEqual(removed.sort(), ['keydown', 'pointerdown']);
});

test('arrow keys on the button open the list; the Space that chose an option does not click it', async (t) => {
  const { $, chosen, key, settle } = fixture(t);
  const button = $('.locale-picker-button');
  key(button, { key: 'ArrowDown' });
  await settle();
  assert.equal($('#locale-picker-popup').hidden, false);
  const list = $('#locale-picker-listbox');
  key(list, { key: 'ArrowDown' });
  key(list, { key: ' ' });
  await settle();
  assert.deepEqual(chosen, ['de']);
  assert.equal(document.activeElement === button, true);
  const keyup = new KeyboardEvent('keyup', {
    key: ' ',
    bubbles: true,
    cancelable: true,
  });
  button.dispatchEvent(keyup);
  assert.equal(keyup.defaultPrevented, true);
  const nextKeyup = new KeyboardEvent('keyup', {
    key: ' ',
    bubbles: true,
    cancelable: true,
  });
  button.dispatchEvent(nextKeyup);
  assert.equal(nextKeyup.defaultPrevented, false);
});

test('pointing at an option makes it the active one', async (t) => {
  const { $, settle } = fixture(t);
  $('.locale-picker-button').click();
  await settle();
  $('[data-locale="es"] .locale-picker-native').dispatchEvent(
    new PointerEvent('pointermove', { bubbles: true }),
  );
  await settle();
  assert.equal(
    $('#locale-picker-listbox').getAttribute('aria-activedescendant'),
    'locale-picker-option-es',
  );
});

test('the provider settings corner shows the picker only while the shell publishes one', async (t) => {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(ProviderSettingsView).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  const store = useLocaleStore(pinia);
  assert.equal(document.getElementById('locale-picker'), null);
  store.publishPicker({ current: 'de', onSelect() {} });
  await nextTick();
  const code = document.querySelector('#corner-actions .locale-picker-code');
  assert.equal(code?.textContent, 'DE');
  store.publishPicker(null);
  await nextTick();
  assert.equal(document.getElementById('locale-picker'), null);
});
