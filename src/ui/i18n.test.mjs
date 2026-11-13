import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../testSupport/vueDom.mjs';

let vue;
let i18n;
let applicationI18n;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  vue = await import('vue');
  i18n = await import('../i18n/index.js');
  ({ applicationI18n } = await import('./i18n.js'));
});
after(() => {
  i18n.setLocale('en');
  uninstall();
});

test('vue-i18n takes the locale set before it and holds the catalogs', () => {
  i18n.setLocale('ru');
  const { global } = applicationI18n();
  assert.equal(applicationI18n(), applicationI18n());
  assert.equal(global.locale.value, 'ru');
  assert.equal(global.te('Settings'), true);
  assert.equal(global.tm('Settings'), 'Настройки');
  global.locale.value = 'de';
  assert.equal(i18n.getLocale(), 'de');
  global.locale.value = 'ru_RU';
  assert.equal(i18n.getLocale(), 'ru');
  assert.equal(i18n.t('Settings'), 'Настройки');
  assert.equal(i18n.formatNumber(1234.5), '1\u00a0234,5');
  global.locale.value = 'xx';
  assert.equal(i18n.getLocale(), 'en');
  i18n.setLocale('en');
  assert.equal(global.locale.value, 'en');
});

test('a view that translates re-renders when the locale changes', async () => {
  const { createApp, h, nextTick } = vue;
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp({
    render: () =>
      h('p', [
        i18n.t('Settings'),
        ' / ',
        i18n.tn(
          3,
          'POWER UP · {count} KEY WAITING',
          'POWER UP · {count} KEYS WAITING',
        ),
      ]),
  }).use(applicationI18n());
  app.mount(host);
  assert.equal(host.textContent, 'Settings / POWER UP · 3 KEYS WAITING');
  i18n.setLocale('ru');
  await nextTick();
  assert.equal(host.textContent, 'Настройки / ЗАПУСК · 3 КЛЮЧА В ОЖИДАНИИ');
  i18n.setLocale('en');
  await nextTick();
  assert.equal(host.textContent, 'Settings / POWER UP · 3 KEYS WAITING');
  app.unmount();
  host.remove();
});

test('unmounting one view keeps the page instance for the others', async () => {
  const { createApp, h, nextTick } = vue;
  const page = applicationI18n();
  let disposed = 0;
  const dispose = page.dispose;
  page.dispose = () => {
    disposed += 1;
    dispose.call(page);
  };
  const mountView = () => {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp({ render: () => h('p', i18n.t('Settings')) });
    app.use(page).mount(host);
    return { app, host };
  };
  const first = mountView();
  const second = mountView();
  first.app.unmount();
  assert.equal(disposed, 0);
  i18n.setLocale('ru');
  await nextTick();
  assert.equal(second.host.textContent, 'Настройки');
  const third = mountView();
  assert.equal(third.host.textContent, 'Настройки');
  i18n.setLocale('en');
  second.app.unmount();
  third.app.unmount();
  page.dispose = dispose;
});
