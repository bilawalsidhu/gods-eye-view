// cards.i18n.test.mjs covers the same card in another language.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../../i18n/index.js';
import { buildSignCard, dataAgeText } from './cards.js';

setLocale('en');

const sign = {
  location: 'I-35W NB @ 40th St',
  multi: 'FREEWAY TIME TO[nl][jl2]I-394       7 MI [jl4]10 MIN',
};

test('the card shows the location, the message lines and the data age', () => {
  const card = buildSignCard(sign, { ageMs: 45_000, stale: false });
  assert.equal(card.title, 'SIGN · I-35W NB @ 40th St');
  assert.deepEqual(card.details, [
    'FREEWAY TIME TO',
    'I-394  7 MI  10 MIN',
    'MnDOT data 45 seconds ago',
  ]);
  assert.equal(
    card.spoken,
    'Message sign, I-35W NB @ 40th St. FREEWAY TIME TO, I-394 7 MI 10 MIN. ' +
      'MnDOT data 45 seconds ago',
  );
});

test('stale data is marked, and older data reads in minutes', () => {
  const card = buildSignCard(sign, { ageMs: 185_000, stale: true });
  assert.equal(card.details.at(-1), 'STALE · MnDOT data 3 minutes ago');
  assert.equal(dataAgeText(0), 'now');
  assert.equal(dataAgeText(30_000), '30 seconds ago');
});

test('pages are numbered and a graphic-only message says so', () => {
  const pages = buildSignCard(
    { location: 'I-94 WB', multi: 'SLOW TRAFFIC AHEAD[np]USE CAUTION' },
    { ageMs: 0, stale: false },
  );
  assert.deepEqual(pages.details.slice(0, 4), [
    'Page 1 of 2',
    'SLOW TRAFFIC AHEAD',
    'Page 2 of 2',
    'USE CAUTION',
  ]);
  const graphic = buildSignCard(
    { location: 'I-94 WB', multi: '[g1,8,1]' },
    { ageMs: 0, stale: false },
  );
  assert.equal(graphic.details[0], 'Graphic only');
});

test('a long location is cut in the title but spoken in full', () => {
  const location = 'X'.repeat(80);
  const card = buildSignCard(
    { location, multi: 'OPEN' },
    { ageMs: 0, stale: false },
  );
  assert.equal(card.title, `SIGN · ${'X'.repeat(47)}…`);
  assert.ok(card.spoken.includes(location));
});
