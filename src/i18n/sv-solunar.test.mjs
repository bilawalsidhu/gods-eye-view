// The SOLUNAR card's strings in Swedish: every locale ships them, so
// Swedish must too, each one a real translation (not the English left in)
// with its placeholders intact.
import test from 'node:test';
import assert from 'node:assert/strict';

import { getCatalog } from './index.js';
import { LOCALES } from './locale.js';

/** The card's strings, as every other locale ships them. */
const SOLUNAR_STRINGS = Object.freeze([
  'New Moon',
  'Waxing Crescent',
  'First Quarter',
  'Waxing Gibbous',
  'Full Moon',
  'Waning Gibbous',
  'Last Quarter',
  'Waning Crescent',
  'Moon overhead',
  'Moon underfoot',
  'Moonrise',
  'Moonset',
  'none',
  'Click the map to choose a spot',
  'Use map centre',
  '12 h',
  '24 h',
  'Times are local to the spot ({zone})',
  '{percent}% lit',
  'Hunting',
  'Fishing',
  '{label}: {stars} of {max} stars',
  'Major window',
  'Minor window',
  'Sunrise',
  'Sunset',
  'How the stars are rated',
  'Moon: new or full moon within {near} day = 2 points, within {close} days = 1 point.',
  'Dawn and dusk: {hours} h either side of sunrise and of sunset.',
  'Fishing: +1 for dawn and +1 for dusk when a major window (moon overhead or underfoot, about 2 h) overlaps it.',
  'Hunting: +1 for dawn and +1 for dusk when any window (major, or minor at moonrise or moonset, about 1 h) overlaps it.',
  'Stars = points, at least 1 and at most 4.',
  'Computed in your browser from the Sun and Moon positions. No outside data is used.',
  'SOLUNAR',
  'Solunar',
]);

/** The placeholders a string carries, in order. */
const placeholders = (text) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);

test('every locale ships the solunar strings, Swedish included', () => {
  for (const locale of LOCALES.filter((code) => code !== 'en')) {
    const catalog = getCatalog(locale);
    for (const text of SOLUNAR_STRINGS)
      assert.ok(Object.hasOwn(catalog, text), `${locale} lacks "${text}"`);
  }
});

test('the Swedish solunar strings are Swedish and keep their placeholders', () => {
  const catalog = getCatalog('sv');
  // "SOLUNAR", "Solunar", "12 h" and "24 h" are the same in Swedish; the
  // rest are translated, so they must differ from the English.
  const sameInSwedish = new Set(['SOLUNAR', 'Solunar', '12 h', '24 h']);
  for (const text of SOLUNAR_STRINGS) {
    const entry = catalog[text];
    assert.equal(typeof entry, 'string', `"${text}" is not a string`);
    assert.ok(entry.trim(), `"${text}" is empty`);
    assert.deepEqual(
      placeholders(entry),
      placeholders(text),
      `"${text}" placeholders differ`,
    );
    if (!sameInSwedish.has(text))
      assert.notEqual(entry, text, `"${text}" is still English`);
  }
});

test('the Swedish solunar wording is the one the style guide asks for', () => {
  const catalog = getCatalog('sv');
  assert.equal(catalog.Sunrise, 'Soluppgång');
  assert.equal(catalog.Sunset, 'Solnedgång');
  assert.equal(catalog.Hunting, 'Jakt');
  assert.equal(catalog.Fishing, 'Fiske');
  assert.equal(catalog.none, 'ingen');
  assert.equal(catalog['Moon overhead'], 'Månen i zenit');
  assert.equal(catalog['Moon underfoot'], 'Månen i nadir');
  // Sentence case, not Title Case.
  assert.equal(catalog['New Moon'], 'Ny måne');
  assert.equal(catalog['First Quarter'], 'Första kvartilen');
});
