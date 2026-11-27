import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { styleFixture } from '../testSupport/styleFixture.mjs';

function tiles(t) {
  return styleFixture(
    t,
    ['entity-card'],
    `
    <div class="view-context__tiles"><div class="view-context__tile">
      <span class="view-context__tile-name"><span>Long name</span></span><strong id="count">50</strong>
    </div></div>
    <div class="view-context__tiles view-context__tiles--facts"><div class="view-context__tile">
      <strong id="fact">50</strong><strong class="view-context__tile-status">Unavailable</strong>
    </div></div>
    <section id="entity-card"><div class="entity-card__tile"><strong>Long value</strong></div></section>`,
  );
}

test('layer names and card figures wrap to two lines and the full figure remains available', (t) => {
  const css = tiles(t);
  for (const selector of [
    '.view-context__tile-name > span',
    '.entity-card__tile strong',
  ]) {
    const style = css(selector);
    assert.notEqual(style.whiteSpace, 'nowrap');
    assert.equal(style.getPropertyValue('line-clamp'), '2');
    assert.equal(style.overflow, 'hidden');
    // Happy DOM drops display: -webkit-box. A competing flex/block declaration
    // would still win here and break the clamp.
    assert.ok(['', '-webkit-box'].includes(style.display));
  }
  // Verify the legacy WebKit declarations Happy DOM omits from its CSSOM.
  const sheet = readFileSync(
    new URL('./styles/entity-card.css', import.meta.url),
    'utf8',
  );
  for (const selector of [
    '.view-context__tile-name > span:last-child',
    '.entity-card__tile strong',
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const block =
      sheet.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ??
      '';
    assert.match(block, /display:\s*-webkit-box/);
    assert.match(block, /-webkit-line-clamp:\s*2/);
  }
  const card = readFileSync(
    new URL('./views/panels/EntityCard.vue', import.meta.url),
    'utf8',
  );
  assert.match(card, /class="entity-card__tile" :title="/);
});

test('facts stay on one line and their failure messages can wrap', (t) => {
  const css = tiles(t);
  assert.equal(css('#fact').whiteSpace, 'nowrap');
  const status = css('.view-context__tile-status');
  assert.notEqual(status.whiteSpace, 'nowrap');
  assert.notEqual(status.overflow, 'hidden');
  assert.equal(status.overflowWrap, 'anywhere');
});

test('tiles stretch with their row, with figures at the foot and counts under their names', (t) => {
  const css = tiles(t);
  for (const selector of ['.view-context__tile', '.entity-card__tile']) {
    assert.ok(['', 'auto', 'stretch'].includes(css(selector).alignSelf));
    assert.ok(['', 'auto'].includes(css(selector).height));
  }
  assert.equal(css('#fact').marginTop, 'auto');
  assert.ok(['0', '0px'].includes(css('#count').marginTop));
  assert.equal(css('.entity-card__tile').alignContent, 'space-between');
});
