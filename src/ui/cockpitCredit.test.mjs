// The cockpit view's Esri credit is never under the preview switch: in a
// card's hero it sits above the switch's row, on logical sides, so neither
// the side the switch takes (left in English, right in Arabic or Hebrew) nor
// the number of buttons it holds can cover it. The test DOM has no layout,
// so the stylesheets are checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) =>
  fs
    .readFileSync(new URL(`./styles/${file}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
const css = read('entity-card.css');
const phone = read('mobile-shell.css');

/** Every rule whose selector list ends with `selector`, as `[selector, body]`. */
function rules(sheet, tail) {
  return [...sheet.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .map(([, selector, body]) => [selector.trim().replace(/\s+/g, ' '), body])
    .filter(([selector]) => selector.endsWith(tail));
}
const px = (body, property) => {
  const value = body.match(
    new RegExp(`(?:^|[;\\s])${property}:\\s*(\\d+)px`),
  )?.[1];
  return value === undefined ? null : Number(value);
};

test('the cockpit credit takes logical sides only, and reserves no fixed width for the switch', () => {
  const credit = [
    ...rules(css, '.flight-cockpit__credit'),
    ...rules(phone, '.flight-cockpit__credit'),
  ];
  assert.ok(credit.length >= 3, 'its base, hero and phone rules');
  for (const [selector, body] of credit) {
    assert.doesNotMatch(
      body,
      /(?:^|[;\s])(?:left|right):/,
      `${selector}: no physical side`,
    );
    assert.doesNotMatch(
      body,
      /max-width:\s*calc\(100%\s*-\s*\d+px\)/,
      `${selector}: no fixed reservation`,
    );
  }
  const [, base] = credit.find(
    ([selector]) => selector === '.flight-cockpit__credit',
  );
  assert.match(base, /inset-inline:\s*8px/);
  assert.match(base, /text-align:\s*end/);
});

test('in a hero with a preview switch the credit sits above the switch’s row, as the map’s credit does', () => {
  const [, switchRule] = rules(
    css,
    '.entity-hero .entity-card__preview-switch',
  ).find(
    ([selector]) => selector === '.entity-hero .entity-card__preview-switch',
  );
  assert.match(
    switchRule,
    /inset-inline-start:\s*6px/,
    'the switch takes the start side',
  );
  const switchBottom = px(switchRule, 'bottom');
  const [, mapFoot] = rules(
    css,
    '.entity-hero:has(> .entity-card__preview-switch) .map-foot',
  )[0];
  const [, hero] =
    rules(
      css,
      '.entity-hero:has(> .entity-card__preview-switch) .flight-cockpit__credit',
    )[0] || [];
  assert.ok(hero, 'the hero rule');
  const lifted = px(hero, 'bottom');
  // The switch's row: its offset plus a button's height (about 30 px).
  assert.ok(
    lifted >= switchBottom + 30,
    `credit bottom ${lifted}px clears the switch`,
  );
  assert.ok(lifted >= px(mapFoot, 'bottom'), 'no lower than the map’s credit');
  assert.match(hero, /inset-inline:\s*\d+px/);
});

test('the dock credits the cockpit view under its picture and the phone keeps controls clear of its credit', () => {
  const [, dock] =
    rules(css, '.docked-view__cockpit .flight-cockpit__credit')[0] || [];
  assert.match(dock || '', /display:\s*none/);
  const [, small] =
    rules(phone, '.entity-hero .flight-cockpit__credit')[0] || [];
  assert.ok(small, 'the phone rule');
  assert.ok(px(small, 'bottom') >= 36, 'the credit clears the controls');
  const hidden = rules(phone, '').filter(([, body]) =>
    /display:\s*none/.test(body),
  );
  assert.ok(
    !hidden.some(([selector]) =>
      selector.includes('.entity-card__preview-switch'),
    ),
    'phone preview controls remain available',
  );
  assert.match(small, /inset-inline:\s*\d+px/);
});

// The credit is text a screen reader reads; only the picture, the HUD and
// the tapes are decoration.
test('the cockpit view’s credit is not hidden from screen readers', () => {
  const view = fs.readFileSync(
    new URL('./views/panels/FlightCockpitView.vue', import.meta.url),
    'utf8',
  );
  const template = view.slice(view.indexOf('<template>'));
  const root = template.match(/<div class="flight-cockpit"[^>]*>/)?.[0];
  assert.ok(root, 'the view has its root');
  assert.doesNotMatch(root, /aria-hidden/);
  const credit = template.match(
    /<span class="flight-cockpit__credit"[^>]*>/,
  )?.[0];
  assert.ok(credit, 'the credit is in the view');
  assert.doesNotMatch(credit, /aria-hidden/);
  assert.match(template, /class="flight-cockpit__scene" aria-hidden="true"/);
});
