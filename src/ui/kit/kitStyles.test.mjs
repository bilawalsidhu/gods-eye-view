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
      selectors: prelude.split(',').map((s) => s.replace(/\s+/g, ' ').trim()),
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
  shares('.ui-button--compact', '.gev-action-button--compact');
  shares(
    '.ui-button--compact.ui-button--danger:hover:not(:disabled)',
    '.gev-action-button--compact.gev-action-button--danger:hover:not(:disabled)',
  );
  shares('.ui-button--icon', '.panel-collapse-btn');
  shares('.ui-button--icon:hover', '.panel-collapse-btn:hover');
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
  shares('.ui-button--icon.ui-button--pressed', '.panel-collapse-btn:hover');
});

test('a ghost button and the tones alone carry no style', () => {
  const kitButton =
    /\.ui-button(?:--(?:ghost|accent|danger|alert|pressed))?(?![\w-])/;
  const look = /\.ui-button--(?:action|primary|icon|compact)(?![\w-])/;
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

test('the kit’s skins load before the feature stylesheets that restyle them', () => {
  const at = (selector) => css.indexOf(selector);
  for (const [kit, feature] of [
    ['.ui-chip,', '.gev-voice-card-chip {'],
    ['.ui-empty,', '.scene-shot-empty {'],
    ['.ui-empty,', '.recent-imagery-readout .ri-strip-empty {'],
    ['.ui-empty,', '#space-mission-panel-host .space-mission-roster-empty {'],
    ['.ui-button--icon,', '#command-dock .panel-collapse-btn'],
  ]) {
    assert.ok(
      at(kit) >= 0 && at(feature) > at(kit),
      `${kit} loads before ${feature}`,
    );
  }
});
