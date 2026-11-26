// Preset place names show in the UI language at the presentation boundary
// (voice results, the Omnibar's city chips, HUD); the preset data stays
// English.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';
import { CITY_POIS } from '../cityPois.js';
import { KNOWN_PLACE_NAMES, localizePlaceName } from './placeNames.js';

test.afterEach(() => setLocale('en'));

test('every preset city has a display name entry', () => {
  for (const city of Object.values(CITY_POIS))
    assert.ok(KNOWN_PLACE_NAMES.includes(city.name), city.name);
});

test('en: place names pass through unchanged', () => {
  setLocale('en');
  for (const name of KNOWN_PLACE_NAMES)
    assert.equal(localizePlaceName(name), name);
});

for (const [locale, tokyo, losAngeles] of [
  ['ru', 'Токио', 'Лос-Анджелес'],
  ['es', 'Tokio', 'Los Ángeles'],
]) {
  test(`${locale}: preset names are translated, other places shown as given`, () => {
    setLocale(locale);
    assert.equal(localizePlaceName('Tokyo'), tokyo);
    assert.equal(localizePlaceName('Los Angeles'), losAngeles);
    assert.equal(localizePlaceName('Ulaanbaatar'), 'Ulaanbaatar');
    assert.equal(localizePlaceName(undefined), undefined);
  });
}
