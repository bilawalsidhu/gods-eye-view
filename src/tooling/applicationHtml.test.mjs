import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  expandApplicationHtml,
  APPLICATION_TEMPLATES,
} from '../../build/application-html.js';

test('the standalone document expands every component once and preserves unique element ids', () => {
  const source = readFileSync(
    new URL('../../index.html', import.meta.url),
    'utf8',
  );
  const html = expandApplicationHtml(source);
  assert.equal(
    [...source.matchAll(/gev:template /g)].length,
    APPLICATION_TEMPLATES.length,
  );
  assert.doesNotMatch(html, /gev:template/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /id="cesiumContainer"/);
  assert.match(html, /type="module" src="\/src\/main.js"/);
});

test('component selection includes only requested markup and refuses filesystem traversal', () => {
  const html = expandApplicationHtml('<!-- gev:template welcome -->\n');
  assert.match(html, /id="first-run-launcher"/);
  assert.doesNotMatch(html, /id="cesiumContainer"/);
  assert.throws(
    () => expandApplicationHtml('<!-- gev:template ../../.env -->'),
    /Unknown application template/,
  );
});
