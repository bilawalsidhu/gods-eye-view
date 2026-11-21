// The fishing rating's label: English shows the plain word, and a translated
// locale shows its solunar entry rather than the plain "Fishing" vessel entry.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { dayCard } from './format.js';
import { getCatalog, setLocale } from '../i18n/index.js';

const DAY = Object.freeze({
  date: '2026-11-02',
  startMs: Date.UTC(2026, 10, 2),
  endMs: Date.UTC(2026, 10, 3),
  phase: 'Full Moon',
  illumination: 0.99,
  huntingStars: 3,
  fishingStars: 2,
  windows: [],
  sunrise: [Date.UTC(2026, 10, 2, 12)],
  sunset: [Date.UTC(2026, 10, 2, 23)],
  moonrise: [Date.UTC(2026, 10, 2, 18)],
  moonset: [Date.UTC(2026, 10, 2, 6)],
  moonUpper: [Date.UTC(2026, 10, 2, 20)],
  moonLower: [Date.UTC(2026, 10, 2, 8)],
});

const fishingLabel = () =>
  dayCard(DAY, 'UTC', true, 4).stars.find((row) => row.key === 'fishing')
    .label;

after(() => setLocale('en'));

test('English shows the plain fishing word on the card', () => {
  setLocale('en');
  assert.equal(fishingLabel(), 'Fishing');
});

test('a translated locale shows its solunar entry, not the vessel entry', () => {
  setLocale('de');
  const catalog = getCatalog('de');
  assert.notEqual(catalog['solunar|Fishing'], catalog.Fishing);
  assert.equal(fishingLabel(), catalog['solunar|Fishing']);
  assert.notEqual(fishingLabel(), catalog.Fishing);
});
