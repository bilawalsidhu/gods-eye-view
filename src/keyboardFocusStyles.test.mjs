import { readStylesheet } from './testSupport/readStylesheet.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const css = readStylesheet(new URL('../style.css', import.meta.url));

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
    '.gev-action-button--compact {',
  ]) {
    assert.doesNotMatch(
      ruleBody(selector),
      /transition:\s*all\b/,
      `${selector} must leave the focus outline immediate`,
    );
  }
});
