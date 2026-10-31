import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  expandApplicationHtml,
  APPLICATION_TEMPLATES,
} from '../../build/application-html.js';
import { APPLICATION_VIEW_NAMES } from '../../build/applicationViews.js';
import { APPLICATION_VIEWS } from '../ui/views/index.js';
import { readApplicationHtml } from '../testSupport/applicationHtml.mjs';

test('the standalone document expands every component once and preserves unique element ids', async () => {
  const source = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const html = await readApplicationHtml();
  assert.equal([...source.matchAll(/gev:template /g)].length, APPLICATION_TEMPLATES.length);
  assert.doesNotMatch(html, /gev:template/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /id="cesiumContainer"/);
  assert.match(html, /type="module" src="\/src\/main.js"/);
});

test('component selection includes only requested markup and refuses filesystem traversal', () => {
  const html = expandApplicationHtml('<!-- gev:template hud-loading -->\n');
  assert.match(html, /id="loading-screen"/);
  assert.doesNotMatch(html, /id="cesiumContainer"/);
  assert.throws(() => expandApplicationHtml('<!-- gev:template ../../.env -->'), /Unknown application template/);
});

test('views expand to mount hosts, the loading screen stays static, and every view is registered', () => {
  assert.deepEqual(Object.keys(APPLICATION_VIEWS).sort(), [...APPLICATION_VIEW_NAMES].sort());
  for (const name of APPLICATION_VIEW_NAMES) {
    assert.ok(APPLICATION_TEMPLATES.includes(name), name);
    assert.equal(
      expandApplicationHtml(`<!-- gev:template ${name} -->\n`),
      `<div class="gev-view" data-gev-view="${name}"></div>\n`,
    );
  }
  // It paints before any script runs.
  assert.ok(!APPLICATION_VIEW_NAMES.includes('hud-loading'));
});
