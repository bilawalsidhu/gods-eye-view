import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Shell landmark pass (docs/PLAN.md Phase 4, axe `region`): every persistent
 * chrome region carries a named landmark role on its EXISTING container —
 * wrappers were deliberately avoided because a wrapper with transform or
 * filter re-anchors the fixed-position Cesium canvas. These pins keep the
 * landmarks from regressing and keep the banner unique.
 */

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const openTag = (id) => {
  const start = html.indexOf(`id="${id}"`);
  assert.notEqual(start, -1, `# ${id} exists in index.html`);
  const tagStart = html.lastIndexOf('<div', start);
  return html.slice(tagStart, html.indexOf('>', start) + 1);
};

test('the globe surface is a named application landmark', () => {
  assert.match(openTag('cesiumContainer'), /role="application" aria-label="Interactive 3D globe"/);
});

test('the title bar is the only banner landmark', () => {
  assert.match(openTag('title-bar'), /role="banner"/);
  assert.equal((html.match(/role="banner"/g) || []).length, 1, 'exactly one banner landmark');
  // A <header> outside sectioning content (<aside>/<section>/…) also maps to
  // banner and would collide — the first-run launcher learned this the hard way.
  assert.doesNotMatch(html, /<header[^>]*first-run-header/);
  const headers = html.match(/<header[\s>]/g) || [];
  for (const match of html.matchAll(/<header[\s>]/g)) {
    // The window must span the header's nearest sectioning ancestor (the
    // cockpit signal header sits ~20 lines under its <aside>).
    const context = html.slice(Math.max(0, match.index - 1000), match.index);
    assert.match(context, /<(aside|section|article|nav|main)[\s>]/, 'every <header> sits inside sectioning content');
  }
  assert.ok(headers.length >= 1, 'the intentional panel headers are still present');
});

test('every persistent chrome region is a named region landmark', () => {
  const expected = [
    ['cesiumContainer', /role="application" aria-label="Interactive 3D globe"/],
    ['style-indicator', /role="region" aria-label="Active visual style" aria-live="polite"/],
    ['pp-toggles', /role="region" aria-label="Display toggles"/],
    ['command-dock', /role="region" aria-label="Navigation, voice, and visual preset controls"/],
    ['data-panel', /role="region" aria-label="Data layers"/],
    ['cctv-panel', /role="region" aria-label="CCTV cameras"/],
    ['scene-panel', /role="region" aria-label="Scenes"/],
    ['global-context-panel', /role="region" aria-label="Global context"/],
  ];
  for (const [id, landmark] of expected) {
    assert.match(openTag(id), landmark, `#${id} carries its named landmark role`);
  }
  // Region names must be unique or screen-reader users cannot tell them apart.
  const names = [...html.matchAll(/role="region" aria-label="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(names).size, names.length, `region labels are unique (${names.join(', ')})`);
});
