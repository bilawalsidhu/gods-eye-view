// A scalar overlay that cannot be drawn reports a marked English status
// (rendering.js), which the Wind row shows through t() in the UI language.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, t } from '../../i18n/index.js';
import { SCALAR_UNAVAILABLE, WIND_FIELDS } from './fields.js';
import { fieldUnavailableText } from './rendering.js';

for (const locale of ['es', 'ru']) {
  test(`${locale}: every field's unavailable status has a translation`, () => {
    setLocale(locale);
    try {
      const english = Object.keys(WIND_FIELDS)
        .map(fieldUnavailableText)
        .filter((text) => t(text) === text);
      assert.deepEqual(english, []);
    } finally {
      setLocale('en');
    }
  });
}

test('only a known overlay has an unavailable status', () => {
  assert.equal(fieldUnavailableText('constructor'), null);
  assert.equal(fieldUnavailableText('none'), null);
  for (const [overlay, text] of Object.entries(SCALAR_UNAVAILABLE))
    assert.equal(fieldUnavailableText(overlay), text);
});
