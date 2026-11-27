import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { styleFixture } from '../testSupport/styleFixture.mjs';

test('every absolutely laid-out hero kind has a height', (t) => {
  const kinds = [
    'flight',
    'model',
    'satellite',
    'photo',
    'place-street',
    'map',
  ];
  const css = styleFixture(
    t,
    ['entity-card'],
    kinds
      .map((kind) => `<div class="entity-hero" data-hero="${kind}"></div>`)
      .join(''),
  );
  for (const kind of kinds)
    assert.ok(parseFloat(css(`[data-hero="${kind}"]`).height) > 0, kind);
});

for (const kind of ['camera', 'street']) {
  test(`the phone ${kind} hero and its heading span the card and the hero is unclipped`, (t) => {
    document.body.classList.add('mobile-shell');
    t.after(() => document.body.classList.remove('mobile-shell'));
    const css = styleFixture(
      t,
      ['entity-card', 'mobile-shell'],
      `<section id="entity-card"><div class="entity-hero" data-hero="${kind}"></div><header class="entity-card__head"></header></section>`,
    );
    const hero = css('.entity-hero');
    assert.equal(hero.gridColumn, '1 / -1');
    assert.equal(hero.height, 'auto');
    assert.equal(hero.overflow, 'visible');
    assert.equal(css('.entity-card__head').gridColumn, '1 / -1');
  });
}

test('the preview switch buttons are at least 24 px each way', (t) => {
  const css = styleFixture(
    t,
    ['entity-card'],
    '<div class="entity-card__preview-switch"><button><span class="material-symbols-outlined">map</span></button></div>',
  );
  const button = css('button');
  assert.ok(parseFloat(button.height) >= 24);
  assert.ok(parseFloat(button.width) >= 24);
});
