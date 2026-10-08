import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapsLoader } from './mapsLoader.js';

/** A document whose appended scripts the test loads or fails. */
function fakePage() {
  const scripts = [];
  const document = {
    createElement: () => {
      const script = {
        remove() {
          scripts.splice(scripts.indexOf(script), 1);
        },
      };
      return script;
    },
    head: { append: (script) => scripts.push(script) },
  };
  const global = {};
  const library = { name: 'streetView' };
  /** Google's script arrived: it defines google.maps and calls back. */
  const loadScript = () => {
    global.google = {
      maps: { importLibrary: async (name) => ({ ...library, name }) },
    };
    const callback = new URL(scripts.at(-1).src).searchParams.get('callback');
    global[callback]();
  };
  return { document, global, scripts, loadScript };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the API loads once, with the key, asynchronously, and hands out libraries', async () => {
  const page = fakePage();
  const loader = createMapsLoader({ getApiKey: () => 'k-1', ...page });
  const first = loader.importLibrary('streetView');
  const second = loader.importLibrary('streetView');
  await settle();
  assert.equal(page.scripts.length, 1, 'one script for concurrent imports');
  const url = new URL(page.scripts[0].src);
  assert.equal(
    url.origin + url.pathname,
    'https://maps.googleapis.com/maps/api/js',
  );
  assert.equal(url.searchParams.get('key'), 'k-1');
  assert.equal(url.searchParams.get('loading'), 'async');
  assert.equal(page.scripts[0].async, true);
  page.loadScript();
  assert.equal((await first).name, 'streetView');
  assert.equal((await second).name, 'streetView');
  const callback = url.searchParams.get('callback');
  assert.equal(page.global[callback], undefined, 'the callback is cleaned up');
});

test('without a key nothing loads', async () => {
  const page = fakePage();
  const loader = createMapsLoader({ getApiKey: () => null, ...page });
  await assert.rejects(loader.importLibrary('streetView'), /not set/);
  assert.equal(page.scripts.length, 0);
});

test('a script that fails to load can be retried', async () => {
  const page = fakePage();
  const loader = createMapsLoader({ getApiKey: () => 'k', ...page });
  const failed = loader.importLibrary('streetView');
  await settle();
  page.scripts[0].onerror();
  await assert.rejects(failed, /could not load/);
  assert.equal(page.scripts.length, 0, 'the failed script is removed');
  const retry = loader.importLibrary('streetView');
  await settle();
  assert.equal(page.scripts.length, 1);
  page.loadScript();
  assert.equal((await retry).name, 'streetView');
});

test("Google's refusal of the key reaches every listener and the page's own handler", async () => {
  const page = fakePage();
  let before = 0;
  page.global.gm_authFailure = () => before++;
  const loader = createMapsLoader({ getApiKey: () => 'k', ...page });
  const heard = [];
  const stop = loader.onAuthFailure(() => heard.push('a'));
  loader.importLibrary('streetView');
  await settle();
  assert.equal(loader.authFailed(), false);
  page.global.gm_authFailure();
  assert.equal(loader.authFailed(), true);
  assert.deepEqual(heard, ['a']);
  assert.equal(before, 1, 'a handler installed earlier still runs');
  stop();
  page.global.gm_authFailure();
  assert.deepEqual(heard, ['a']);
});

test('a retried load still reports a refusal once, and the page handler once', async () => {
  const page = fakePage();
  let before = 0;
  page.global.gm_authFailure = () => before++;
  const loader = createMapsLoader({ getApiKey: () => 'k', ...page });
  const heard = [];
  loader.onAuthFailure(() => heard.push('a'));
  const failed = loader.importLibrary('streetView');
  await settle();
  page.scripts[0].onerror();
  await assert.rejects(failed);
  loader.importLibrary('streetView');
  await settle();
  page.global.gm_authFailure();
  assert.deepEqual(heard, ['a']);
  assert.equal(before, 1);
});
