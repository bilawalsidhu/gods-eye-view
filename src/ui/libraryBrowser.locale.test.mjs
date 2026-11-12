import test from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../testSupport/vueDom.mjs';
import { setLocale, t } from '../i18n/index.js';

test('a language switch relabels the open dialog and keeps its filters', async (context) => {
  context.after(installVueDom());
  context.after(() => setLocale('en'));
  const { mountLibraryBrowser } = await import('./libraryBrowser.js');
  const library = {
    ready: true,
    subscribe: () => () => {},
    list: () => [],
    summary: () => ({
      entries: 0,
      kinds: { dataset: 0, tiles: 0, pack: 0 },
      themes: [],
      available: 0,
      unavailable: 0,
      added: 0,
      on: 0,
      features: 0,
      featureLayers: 0,
    }),
    reset: async () => 0,
  };
  const browser = mountLibraryBrowser({ library, trigger: null });
  context.after(() => browser.destroy());
  browser.open();
  const search = () =>
    document.querySelector('#data-library input[type="search"]');
  search().value = 'kartverket';
  search().dispatchEvent(new Event('input'));
  assert.equal(
    document.querySelector('#data-library-title').textContent,
    'DATA LIBRARY',
  );

  setLocale('de');
  const title = document.querySelector('#data-library-title');
  assert.equal(title.textContent, t('DATA LIBRARY'));
  assert.notEqual(title.textContent, 'DATA LIBRARY');
  assert.equal(document.querySelectorAll('#data-library').length, 1);
  assert.equal(document.querySelector('#data-library').open, true);
  assert.equal(search().value, 'kartverket');

  // Closed and reopened later, it is still in the new language.
  browser.close();
  browser.open();
  assert.equal(
    document.querySelector('#data-library-title').textContent,
    t('DATA LIBRARY'),
  );
});
