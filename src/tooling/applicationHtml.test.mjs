import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APPLICATION_VIEWS } from '../ui/views/index.js';
import { readApplicationHtml } from '../testSupport/applicationHtml.mjs';

const source = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

test('the standalone document hosts every view once and keeps element ids unique', async () => {
  const hosts = [...source.matchAll(/data-gev-view="([^"]+)"/g)].map((match) => match[1]);
  // Order is stacking order for fixed elements that share a z-index.
  assert.deepEqual(hosts, ['scene-chrome', 'cockpit', 'display-controls', 'command-dock', 'layer-panels', 'context', 'welcome', 'provider-settings', 'intel-hud']);
  assert.deepEqual([...hosts].sort(), Object.keys(APPLICATION_VIEWS).sort());
  const html = await readApplicationHtml();
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /id="cesiumContainer"/);
  assert.match(html, /type="module" src="\/src\/main.js"/);
});

test('the loading screen is static markup, so it paints before any script runs', () => {
  const loading = source.indexOf('id="loading-screen"');
  assert.ok(loading > 0);
  assert.ok(loading < source.indexOf('type="module" src="/src/main.js"'));
  assert.match(source, /class="loader-status" data-i18n>Initializing photorealistic world\.\.\.</);
  assert.doesNotMatch(source, /gev:template/);
});
