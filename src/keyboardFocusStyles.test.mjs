import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

function ruleBody(selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `${selector} rule exists`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function ruleText(selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `${selector} rule exists`);
  const close = css.indexOf('}', css.indexOf('{', start));
  return css.slice(start, close + 1);
}

function ruleBodyContaining(selector, declaration) {
  let start = -1;
  while ((start = css.indexOf(selector, start + 1)) >= 0) {
    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    const body = css.slice(open + 1, close);
    if (body.includes(declaration)) return body;
  }
  assert.fail(`${selector} rule containing ${declaration} exists`);
}

test('the global keyboard ring survives local active and outline-reset rules', () => {
  const rule = ruleText(':where(\n  button,');
  assert.match(rule, /outline:\s*2px solid var\(--text-primary\) !important;/);
  for (const selector of [
    "[role='button']",
    "[role='radio']",
    "[role='slider']",
    "[role='tab']",
    '[tabindex]',
    'a[href]',
  ]) assert.ok(rule.includes(selector), `${selector} receives the global ring`);
});

test('Location city, POI, search toggle and search field use an inset ring', () => {
  const rule = ruleText('.location-pill:focus-visible,');
  assert.match(rule, /\.poi-pill:focus-visible/);
  assert.match(rule, /\.search-toggle-btn:focus-visible/);
  assert.match(rule, /#location-search:focus-visible/);
  assert.match(rule, /outline:\s*2px solid var\(--text-primary\)/);
  assert.match(rule, /outline-offset:\s*-3px/);
  for (const selector of ['.location-pill {', '.poi-pill {', '.search-toggle-btn {']) {
    assert.doesNotMatch(ruleBody(selector), /transition:\s*all\b/);
  }
});

test('Cockpit Display and Radio launcher glyphs have a complete inset ring', () => {
  const body = ruleBody('.cockpit-utility-glyph:focus-visible');
  assert.match(body, /outline:\s*2px solid var\(--text-primary\)/);
  assert.match(body, /outline-offset:\s*-3px/);
  assert.doesNotMatch(body, /outline:\s*none/);
});

test('focusable controls do not animate the global outline', () => {
  for (const selector of [
    '.panel-collapse-btn {',
    '#top-center-actions button {',
    '.data-toggle-chip {',
    '.scene-btn {',
    '.scene-shot-btn {',
  ]) {
    assert.doesNotMatch(
      ruleBody(selector),
      /transition:\s*all\b/,
      `${selector} must leave the focus outline immediate`,
    );
  }
});

test('opening a dock popover makes its controls keyboard-reachable immediately', () => {
  const base = ruleBodyContaining('#command-dock .dock-popover-content {', 'visibility: hidden');
  assert.match(base, /visibility\s+0s\s+linear\s+180ms/);
  const open = ruleText('#command-dock #location-bar:not(.collapsed) .dock-popover-content,');
  assert.match(open, /transition-delay:\s*0s/);
});
