// A copied share link must not carry the sender's ?lang override: on the
// recipient's side ?lang would beat their own stored choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShareLinkManager } from './sharelink.js';
import { resolveLocale } from './i18n/locale.js';
import { persistLocaleAndReload } from './i18n/index.js';

function makeManager(href) {
  globalThis.window = { location: { href, hash: new URL(href).hash } };
  globalThis.history = { replaceState() {} };
  const viewer = {
    camera: {
      changed: { addEventListener() {} },
      positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    },
  };
  return new ShareLinkManager(viewer);
}

function installClipboard(writeText) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText } },
  });
}

test('the copied link does not carry the sender ?lang override', async () => {
  let copied = null;
  installClipboard(async (url) => {
    copied = url;
  });
  const manager = makeManager('https://gev.example/?lang=ru#v=2&lat=10&lon=20');
  assert.equal(await manager.copyLink({ nowMs: 1_000_000 }), true);
  const link = new URL(copied);
  assert.equal(link.searchParams.get('lang'), null, `copied link: ${copied}`);

  const store = new Map([['gev:locale:v1', 'es']]);
  const recipient = resolveLocale({
    location: { search: link.search },
    storage: { getItem: (k) => store.get(k) ?? null },
    languages: ['en-US'],
  });
  assert.equal(recipient, 'es');
});

test('with storage blocked the language picker keeps the choice in ?lang', () => {
  let href = 'https://gev.example/#v=2';
  const location = {
    get href() {
      return href;
    },
    assign(next) {
      href = next;
    },
    reload() {},
  };
  const history = {
    replaceState: (_s, _t, url) => {
      href = url;
    },
  };
  const blocked = {
    setItem() {
      throw new Error('blocked');
    },
  };
  persistLocaleAndReload('ru', { location, history, storage: blocked });
  // Storage blocked: the choice survives only in ?lang.
  assert.equal(new URL(href).searchParams.get('lang'), 'ru');
});
