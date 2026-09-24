import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseApiStripPlugin } from '../../server/standalone/base-api-strip.js';

function collectHandlers(plugin, hook) {
  const handlers = [];
  plugin[hook]({ middlewares: { use: (fn) => handlers.push(fn) } });
  return handlers;
}

function run(handlers, url) {
  const req = { url };
  let nexted = false;
  handlers[0](req, {}, () => {
    nexted = true;
  });
  return { url: req.url, nexted };
}

test('base "/" or absent needs no plugin', () => {
  assert.equal(baseApiStripPlugin('/'), null);
  assert.equal(baseApiStripPlugin(undefined), null);
  assert.equal(baseApiStripPlugin(''), null);
});

test('provider routes lose the base; documents and assets keep it', () => {
  const plugin = baseApiStripPlugin('/gods-eye/');
  const handlers = collectHandlers(plugin, 'configureServer');
  assert.equal(handlers.length, 1);
  assert.deepEqual(run(handlers, '/gods-eye/api/cctv/sources'), {
    url: '/api/cctv/sources',
    nexted: true,
  });
  assert.equal(
    run(handlers, '/gods-eye/api/weather/manifest?product=x').url,
    '/api/weather/manifest?product=x',
  );
  assert.equal(
    run(handlers, '/gods-eye/assets/index-abc.js').url,
    '/gods-eye/assets/index-abc.js',
  );
  assert.equal(run(handlers, '/gods-eye/').url, '/gods-eye/');
  // Already-unprefixed requests (and a second pass) are left untouched.
  assert.equal(run(handlers, '/api/cctv/sources').url, '/api/cctv/sources');
});

test('a base without a trailing slash strips exactly one base', () => {
  const plugin = baseApiStripPlugin('/gods-eye');
  const handlers = collectHandlers(plugin, 'configurePreviewServer');
  assert.equal(run(handlers, '/gods-eye/api/x').url, '/api/x');
  assert.equal(run(handlers, '/gods-eye/api/x').nexted, true);
});
