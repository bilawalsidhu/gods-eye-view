import assert from 'node:assert/strict';
import test from 'node:test';
import { readStylesheet } from '../testSupport/readStylesheet.mjs';

const css = readStylesheet(new URL('../../style.css', import.meta.url));
const clean = (selector) =>
  selector
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, selector, body]) => ({
    selector: clean(selector),
    body: body.replace(/\/\*[\s\S]*?\*\//g, ''),
  }),
);
const railRules = rules.filter(({ selector }) =>
  selector.includes('#left-panel-stack, #right-context-rail'),
);
const hoverBlock =
  css.match(
    /@media \(hover: hover\) and \(pointer: fine\) \{((?:[^{}]*\{[^{}]*\})*)\s*\}/g,
  ) || [];

test('a side panel lights up on hover only where a pointer can hover', () => {
  const lit = railRules.filter(({ selector }) => selector.includes(':hover'));
  assert.ok(lit.length > 0, 'the rail hover rule is missing');
  for (const { selector } of lit) {
    assert.ok(
      hoverBlock.some((block) => clean(block).includes(selector)),
      `${selector} must sit inside @media (hover: hover) and (pointer: fine)`,
    );
  }
});

test('hover lights the border and label, not a shadow', () => {
  const [hover] = railRules.filter(({ selector }) =>
    selector.endsWith(':hover'),
  );
  assert.ok(hover, 'the rail surface hover rule is missing');
  assert.match(hover.body, /border-color:\s*var\(--glass-border-hover\)/);
  assert.doesNotMatch(hover.body, /box-shadow/);
  assert.match(hover.body, /--rail-label-hover:\s*var\(--accent\)/);
  // A low-specificity list: no ID or state selector inside it lifts the rule.
  assert.match(hover.selector, /:where\(/);
});

test('hover recolours only the hovered panel header, never nested sections', () => {
  for (const { selector } of railRules) {
    assert.ok(
      !/\.radio-panel-inner/.test(selector),
      `Radio sits inside Context and must not light up as its own panel: ${selector}`,
    );
    assert.doesNotMatch(
      selector,
      /:hover\s+:is\(/,
      'a descendant colour list would reach labels in the panel body',
    );
  }
  const colour = railRules.find(
    ({ body }) => /--rail-label-hover/.test(body) && /color:/.test(body),
  );
  assert.ok(colour, 'the rail title colour rule is missing');
  assert.match(colour.selector, /\.panel-header > \.panel-title/);
  const radio = rules.find(({ selector }) => selector === '#radio-panel');
  assert.match(radio?.body || '', /--rail-label-hover:\s*initial/);
});

test('no later rule dims the open Context title below its siblings', () => {
  const dimmed = rules.filter(
    ({ selector, body }) =>
      /#global-context-panel:not\(\.collapsed\) \.panel-title$/.test(
        selector,
      ) && /color:/.test(body),
  );
  assert.deepEqual(dimmed, []);
});

test('collapsed launchers on both rails keep titles inside the card', () => {
  const ellipsis = railRules.find(
    ({ selector, body }) =>
      selector.endsWith(
        ':is(.panel-header > .panel-title, .pp-header-label)',
      ) && /text-overflow:\s*ellipsis/.test(body),
  );
  assert.ok(
    ellipsis,
    'rail titles must end in an ellipsis rather than overflow',
  );
  assert.match(ellipsis.body, /min-width:\s*0/);

  const translated = rules.find(
    ({ selector }) =>
      selector.startsWith("html:not([lang='en'])") &&
      selector.includes('#left-panel-stack, #right-context-rail') &&
      selector.includes('.panel-collapsible.collapsed'),
  );
  assert.ok(translated, 'translated collapsed titles must fit on both rails');
  assert.match(translated.body, /font-size:\s*8px/);
  // Chinese and Japanese titles fit at full size; 8px would put them under
  // the 9px CJK floor in cjk.css.
  assert.match(translated.selector, /:not\(:lang\(zh\)\):not\(:lang\(ja\)\)/);
  // Only the rail's own launchers: Radio, nested in Context, keeps its type.
  assert.match(
    translated.selector,
    /#right-context-rail\) > \.panel-collapsible\.collapsed > \[class\$='-panel-inner'\] > \.panel-header > \.panel-title$/,
  );
});

test('a collapsed launcher drops its divider so English titles fit whole', () => {
  const launcher = (tail) =>
    railRules.filter(({ selector }) =>
      selector
        .split(/,(?![^(]*\))/)
        .some((part) =>
          part
            .trim()
            .endsWith(
              `.collapsed > [class$='-panel-inner'] > .panel-header${tail}`,
            ),
        ),
    );
  const [header] = launcher('');
  const [divider] = launcher(' > .panel-divider');
  const [toggle] = launcher(' > .panel-collapse-btn');
  assert.match(header?.body || '', /gap:\s*8px/, 'the launcher header gap');
  assert.match(divider?.body || '', /display:\s*none/, 'the launcher divider');
  assert.match(
    toggle?.body || '',
    /margin-left:\s*auto/,
    'the launcher toggle',
  );
  // The kit's icon button shares the toggle's rule.
  const button = rules.find(({ selector }) =>
    selector.split(', ').includes('.panel-collapse-btn'),
  );
  assert.match(
    button?.body || '',
    /flex-shrink:\s*0/,
    'a long title must not squeeze the toggle',
  );
});

test('the default theme geometry change leaves the base gutters alone', () => {
  for (const surface of [
    '.data-panel-inner',
    '.utilities-panel-inner',
    '.global-context-panel-inner',
  ]) {
    // A surface may share its rule with another (`.data-panel-inner,
    // .utilities-panel-inner {`).
    const base = rules.find(
      ({ selector, body }) =>
        selector
          .split(',')
          .map((part) => part.trim())
          .includes(surface) && /padding:/.test(body),
    );
    assert.match(base?.body || '', /padding:\s*14px 16px 12px/, surface);
  }
  const display = rules.find(
    ({ selector }) =>
      selector === '#pp-toggles > .pp-header-row .pp-collapse-btn',
  );
  assert.match(display?.body || '', /font-size:\s*12px/);
});

test('Data Layers, Context and Space Missions share the 14px side gutters', () => {
  const gutters = rules.find(
    ({ selector, body }) =>
      /:is\(\s*\.data-panel-inner,\s*\.global-context-panel-inner,\s*\.space-missions-panel-inner\s*\)$/.test(
        selector,
      ) && /padding-left:\s*14px/.test(body),
  );
  assert.ok(gutters, 'one rule sets the shared gutters');
  assert.match(gutters.body, /padding-right:\s*14px/);
});

test('rail titles take the shared label tokens', () => {
  const rail = railRules.find(({ body }) =>
    /--dock-label-font-size/.test(body),
  );
  // The shared rem type, capped at its 16px-root size: a collapsed launcher
  // is a fixed 176px, so a larger browser font must not cut titles short.
  assert.match(
    rail?.body || '',
    /font-size:\s*min\(var\(--dock-label-font-size\),\s*9\.28px\)/,
  );
  assert.match(
    rail?.body || '',
    /letter-spacing:\s*min\(var\(--dock-label-letter-spacing\),\s*2\.08px\)/,
  );
});

test('launcher compaction and header colour stay on the rail panels themselves', () => {
  // The divider, gap and toggle rules; the translated type rule is checked
  // above.
  const compact = railRules.filter(
    ({ selector }) =>
      /\.collapsed > \[class\$='-panel-inner'\] > \.panel-header/.test(
        selector,
      ) && !selector.startsWith('html:'),
  );
  assert.equal(compact.length, 3);
  for (const { selector } of compact) {
    // Each launcher is a direct child of its rail: Radio, nested inside
    // Context, is not a launcher. The header must not itself be required to
    // be a rail child.
    assert.match(
      selector,
      /#right-context-rail\) > \.panel-collapsible\.collapsed > \[class\$='-panel-inner'\] > \.panel-header/,
    );
    assert.match(
      selector,
      /#right-context-rail\) > #pp-toggles\.collapsed > \.pp-header-row/,
    );
  }
  const colour = railRules.find(({ body }) =>
    /--rail-label-hover, /.test(body),
  );
  assert.match(
    colour.selector,
    /:is\(\.panel-header, \.pp-header-row\) > \.panel-collapse-btn/,
  );
  assert.doesNotMatch(colour.selector, /, \.panel-collapse-btn\)/);
});
