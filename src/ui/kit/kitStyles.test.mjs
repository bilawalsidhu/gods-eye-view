// The kit's classes wear Core's standard looks: each shares one selector list
// with the Core skin it comes from, so the rules are never copied, and the
// default ghost button carries none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStylesheet } from '../../testSupport/readStylesheet.mjs';

const css = readStylesheet(new URL('../../../style.css', import.meta.url));

/** Each rule's selectors, outside @media and other at-rule preludes. */
function rules(source) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '');
  let match;
  while ((match = re.exec(bare))) {
    const prelude = match[1].split('}').pop().trim();
    if (prelude.startsWith('@')) continue;
    out.push({
      selectors: prelude
        .split(',')
        .map((s) =>
          s
            .replace(/\s+/g, ' ')
            .replace(/\( /g, '(')
            .replace(/ \)/g, ')')
            .trim(),
        ),
      body: match[2],
    });
  }
  return out;
}
const all = rules(css);

/** The rule that lists exactly `selector`, which must exist. */
function ruleWith(selector) {
  const found = all.filter((rule) => rule.selectors.includes(selector));
  assert.equal(found.length, 1, `one rule lists ${selector}`);
  return found[0];
}

/** `kit` and `core` share one rule, so the kit wears Core's skin unchanged. */
function shares(kit, core) {
  const rule = ruleWith(kit);
  assert.ok(rule.selectors.includes(core), `${kit} shares ${core}'s rule`);
  return rule;
}

test('UiButton variants wear Core’s action and icon skins', () => {
  shares('.ui-button--action', '.gev-action-button');
  shares('.ui-button--primary', '.gev-action-button');
  shares(
    '.ui-button--action:hover:not(:disabled)',
    '.gev-action-button:hover:not(:disabled)',
  );
  shares('.ui-button--action:disabled', '.gev-action-button:disabled');
  shares(
    '.ui-button--action.ui-button--danger:hover:not(:disabled)',
    '.gev-action-button--danger:hover:not(:disabled)',
  );
  shares(
    '.ui-button--primary:where(:not(:disabled))',
    '#scene-panel .scene-btn-primary:not(:disabled)',
  );
  shares(
    '.ui-button--compact:where(.ui-button--action)',
    '.gev-action-button--compact',
  );
  shares(
    '.ui-button--compact:where(.ui-button--action):hover:not(:disabled):not(.ui-button--pressed)',
    '.gev-action-button--compact:hover:not(:disabled)',
  );
  shares(
    '.ui-button--compact.ui-button--danger:where(.ui-button--action):hover:not(:disabled)',
    '.gev-action-button--compact.gev-action-button--danger:hover:not(:disabled)',
  );
  shares('.ui-button--icon', '.panel-collapse-btn');
  shares('.ui-button--icon:hover:not(:disabled)', '.panel-collapse-btn:hover');
  assert.match(ruleWith('.ui-button--icon:disabled').body, /opacity:\s*0\.45/);
});

test('a pressed styled button looks as a hovered one does', () => {
  shares(
    '.ui-button--action.ui-button--pressed:not(:disabled)',
    '.gev-action-button:hover:not(:disabled)',
  );
  shares(
    '.ui-button--primary.ui-button--pressed:not(:disabled)',
    '.gev-action-button:hover:not(:disabled)',
  );
  shares(
    '.ui-button--action.ui-button--danger.ui-button--pressed:not(:disabled)',
    '.gev-action-button--danger:hover:not(:disabled)',
  );
  shares(
    '.ui-button--icon.ui-button--pressed:not(:disabled)',
    '.panel-collapse-btn:hover',
  );
});

test('a ghost button, the tones and the size alone carry no style', () => {
  const kitButton =
    /\.ui-button(?:--(?:ghost|accent|danger|pressed|compact))?(?![\w-])/;
  // size="compact" styles the action variant only.
  const look = /\.ui-button--(?:action|primary|icon)(?![\w-])/;
  for (const rule of all)
    for (const selector of rule.selectors)
      assert.ok(
        !kitButton.test(selector) || look.test(selector),
        `${selector} styles a kit button without a look`,
      );
});

test('UiChip, UiEmpty, UiBadge and UiSegmented wear Core’s skins', () => {
  shares('.ui-chip', '.news-chip');
  shares('.ui-chip--selected', '.news-chip--official');
  shares('.ui-empty', '.news-readout__empty');
  assert.match(ruleWith('.ui-empty__hint').body, /display:\s*block/);
  shares('.ui-badge', '.gev-status-badge');
  shares('.ui-badge[hidden]', '.gev-status-badge[hidden]');
  shares('.ui-segmented', '.gev-segmented');
  shares('.ui-segmented[hidden]', '.gev-segmented[hidden]');
  shares('.ui-segmented__item', '.gev-segment');
  shares(
    '.ui-segmented__item + .ui-segmented__item',
    '.gev-segment + .gev-segment',
  );
  shares(
    ".ui-segmented__item[aria-checked='true']",
    ".gev-segment[aria-checked='true']",
  );
  shares(
    '.ui-segmented__item:hover:not(:disabled)',
    '.gev-segment:hover:not(:disabled)',
  );
  shares('.ui-segmented__item:focus-visible', '.gev-segment:focus-visible');
  shares('.ui-segmented__item:disabled', '.gev-segment:disabled');
});

test('UiCloseButton wears the bare glyph look the guide’s close shares', () => {
  const rule = shares('.ui-close-button', '.gev-guide-close');
  for (const declaration of [
    /padding:\s*0;/,
    /border:\s*0;/,
    /background:\s*none;/,
    /cursor:\s*pointer;/,
  ])
    assert.match(rule.body, declaration);
});

test('UiSearchField owns the row and bare input both search skins drew', () => {
  const frame = ruleWith('.ui-search-field');
  assert.deepEqual(frame.selectors, ['.ui-search-field']);
  assert.match(frame.body, /display:\s*flex;/);
  assert.match(frame.body, /align-items:\s*center;/);
  const input = ruleWith('.ui-search-field__input');
  assert.deepEqual(input.selectors, ['.ui-search-field__input']);
  for (const declaration of [
    /min-width:\s*0;/,
    /background:\s*none;/,
    /border:\s*0;/,
  ])
    assert.match(input.body, declaration);
  // The browser's cancel button is each skin's own: Context hides it, the
  // Layer Finder keeps it.
  assert.ok(
    !all.some((rule) =>
      rule.selectors.some((s) =>
        s.startsWith('.ui-search-field__input::-webkit-search-cancel-button'),
      ),
    ),
  );
  // Each declaration lives once, in the kit's rule.
  for (const [selector, kit] of [
    ['.context-search', frame],
    ['.layer-finder__field', frame],
    ['.context-search__input', input],
    ['.layer-finder__field input', input],
  ]) {
    const feature = ruleWith(selector);
    for (const property of kit.body.match(/[\w-]+(?=:)/g))
      assert.doesNotMatch(
        feature.body,
        new RegExp(`(^|[\\s;])${property}:`),
        `${selector} leaves ${property} to the kit`,
      );
  }
});

test('UiCheckbox owns the centred row the checkbox-only labels drew', () => {
  const label = ruleWith('.ui-checkbox');
  assert.deepEqual(label.selectors, ['.ui-checkbox']);
  assert.match(label.body, /display:\s*flex;/);
  assert.match(label.body, /align-items:\s*center;/);
  // The box keeps each skin's size, margin and accent colour.
  assert.ok(
    !all.some((rule) =>
      rule.selectors.some((s) => s.startsWith('.ui-checkbox__input')),
    ),
  );
  // Labels that hold only a checkbox leave the row to the kit; the Visual
  // and voice rows share their classes with buttons and other labels, so
  // theirs stay.
  for (const selector of ['.first-run-suppress', '.data-library-check']) {
    const feature = ruleWith(selector);
    for (const property of ['display', 'align-items'])
      assert.doesNotMatch(
        feature.body,
        new RegExp(`(^|[\\s;])${property}:`),
        `${selector} leaves ${property} to the kit`,
      );
  }
});

test('UiSwitch owns the switch look: its track and knob, on and off', () => {
  const track = ruleWith('.ui-switch');
  assert.deepEqual(track.selectors, ['.ui-switch']);
  for (const declaration of [
    /width:\s*30px;/,
    /height:\s*16px;/,
    /border-radius:\s*999px;/,
  ])
    assert.match(track.body, declaration);
  assert.match(ruleWith('.ui-switch::before').body, /inset:\s*-6px -2px;/);
  assert.match(ruleWith('.ui-switch__knob').body, /border-radius:\s*50%;/);
  assert.match(
    ruleWith(".ui-switch[aria-checked='true'] .ui-switch__knob").body,
    /transform:\s*translateX\(14px\);/,
  );
  assert.match(
    ruleWith("html[dir='rtl'] .ui-switch[aria-checked='true'] .ui-switch__knob")
      .body,
    /transform:\s*translateX\(-14px\);/,
  );
  // The look lives once, in the kit: the rail card's switch rules moved
  // there rather than being copied.
  assert.ok(
    !all.some((rule) =>
      rule.selectors.some((s) => s.includes('.rail-card-switch')),
    ),
  );
});

test('the kit’s skins load before the feature stylesheets that restyle them', () => {
  const at = (selector) => css.indexOf(selector);
  for (const [kit, feature] of [
    ['.ui-chip,', '.gev-voice-card-chip {'],
    ['.ui-empty,', '.scene-shot-empty {'],
    ['.ui-empty,', '.recent-imagery-readout .ri-strip-empty {'],
    ['.ui-empty,', '#space-mission-panel-host .space-mission-roster-empty {'],
    ['.ui-close-button,', '.data-toggle-chip {'],
    ['.ui-close-button,', '.geo-import-action {'],
    ['.ui-close-button,', '.panel-surface-control {'],
    ['.ui-close-button,', '.gev-voice-card-dismiss {'],
    ['.ui-close-button,', '.bhote-event-icon-btn {'],
    ['.ui-close-button,', '.entity-card__close {'],
    ['.ui-close-button,', '.context-search__clear {'],
    ['.ui-close-button,', '.key-setup-close {'],
    ['.ui-close-button,', '.cctv-popup__close {'],
    ['.ui-close-button,', '.gev-guide-close {'],
    ['.ui-search-field {', '.context-search {'],
    ['.ui-search-field {', '.layer-finder__field {'],
    ['.ui-search-field__input {', '.context-search__input {'],
    ['.ui-search-field__input {', '.layer-finder__field input {'],
    ['.ui-checkbox {', '.pp-toggle-btn {'],
    ['.ui-checkbox {', '.gev-voice-preference {'],
    ['.ui-checkbox {', '.data-library-check {'],
    ['.ui-checkbox {', '.first-run-suppress {'],
    ['.ui-switch {', '.rail-card-toggle {'],
  ]) {
    assert.ok(
      at(kit) >= 0 && at(feature) > at(kit),
      `${kit} loads before ${feature}`,
    );
  }
});

test('feature rules over a kit skin keep the type they inherit', () => {
  // The chip and empty skins set a font and colour; these feature surfaces
  // inherit theirs from the card or strip around them.
  for (const [selector, property] of [
    ['.gev-voice-card-chip', /font:\s*inherit/],
    ['.scene-shot-empty', /font:\s*inherit/],
    ['.recent-imagery-readout .ri-strip-empty', /font:\s*inherit/],
    ['.recent-imagery-readout .ri-strip-empty', /color:\s*inherit/],
  ])
    assert.ok(
      all.some(
        (rule) => rule.selectors.includes(selector) && property.test(rule.body),
      ),
      `${selector} keeps ${property}`,
    );
});
