// The build fails unless only the startup language's catalog loads with the
// page: no catalog in a startup chunk, each in a chunk of its own
// (build/localeChunks.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localeChunkProblems,
  localeChunksPlugin,
  shippedCatalogLocales,
} from '../../build/localeChunks.js';
import { DEFAULT_LOCALE, LOCALES } from '../i18n/locale.js';
import { createBrowserViteConfig } from '../../build/vite.js';

const ROOT = '/repo/src';
const catalog = (locale) => `${ROOT}/i18n/locales/${locale}.json`;

function chunk(fileName, modules, { isEntry = false, imports = [] } = {}) {
  return {
    type: 'chunk',
    fileName,
    isEntry,
    imports,
    modules: Object.fromEntries(modules.map((id) => [id, {}])),
  };
}

function bundleOf(...chunks) {
  return Object.fromEntries(chunks.map((c) => [c.fileName, c]));
}

const translator = `${ROOT}/i18n/index.js`;

test('every shipped locale but English has a catalog file', () => {
  assert.deepEqual(
    shippedCatalogLocales(),
    LOCALES.filter((locale) => locale !== DEFAULT_LOCALE).sort(),
  );
});

test('catalogs in chunks of their own, loaded on demand, pass', () => {
  const bundle = bundleOf(
    chunk('index.js', [translator, `${ROOT}/main.js`], {
      isEntry: true,
      imports: ['vendor.js'],
    }),
    chunk('vendor.js', ['/repo/node_modules/vue/index.js']),
    chunk('ar.js', [catalog('ar')]),
    chunk('de.js', [catalog('de')]),
  );
  assert.deepEqual(localeChunkProblems(bundle, ['ar', 'de']), []);
});

test('a catalog in the entry or a chunk it imports statically fails', () => {
  const bundle = bundleOf(
    chunk('index.js', [translator, catalog('ar')], {
      isEntry: true,
      imports: ['shared.js'],
    }),
    chunk('shared.js', [catalog('de'), `${ROOT}/util.js`]),
  );
  assert.deepEqual(localeChunkProblems(bundle, ['ar', 'de']), [
    'index.js loads at startup and carries the ar catalog',
    'index.js is not a chunk of its own catalog: it carries 2 modules',
    'shared.js loads at startup and carries the de catalog',
    'shared.js is not a chunk of its own catalog: it carries 2 modules',
  ]);
});

test('a shipped catalog with no chunk fails', () => {
  const bundle = bundleOf(
    chunk('index.js', [translator], { isEntry: true }),
    chunk('ar.js', [catalog('ar')]),
  );
  assert.deepEqual(localeChunkProblems(bundle, ['ar', 'de']), [
    'the de catalog has no chunk of its own',
  ]);
  // A build without the translator ships no catalog at all.
  assert.deepEqual(
    localeChunkProblems(
      bundleOf(chunk('worker.js', [`${ROOT}/worker.js`], { isEntry: true })),
      ['ar', 'de'],
    ),
    [],
  );
});

test('the browser build runs the check; a one-file build skips it', () => {
  const plugins = createBrowserViteConfig().plugins.flat();
  assert.ok(plugins.some((plugin) => plugin?.name === 'locale-chunks'));
  const plugin = localeChunksPlugin();
  const errors = [];
  const context = { error: (message) => errors.push(message) };
  const inlined = bundleOf(
    chunk('panel.js', [translator, catalog('ar')], { isEntry: true }),
  );
  plugin.generateBundle.call(context, { inlineDynamicImports: true }, inlined);
  assert.deepEqual(errors, []);
  plugin.generateBundle.call(context, {}, inlined);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /index\.js|panel\.js loads at startup/);
});
