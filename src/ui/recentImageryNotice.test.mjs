// Box-tool and model refusals on the Recent Imagery notice line are
// shown in the UI language; the layer keeps them in English.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setLocale } from '../i18n/index.js';
import { validateBox } from '../layers/recentImagery/model.js';
import { localizeNotice } from './recentImagery.js';

const REFUSALS = [
  'Drag to size the box', // imageryBoxTool.js, click without drag
  'Press on the ground, not the sky', // imageryBoxTool.js
  'Point the camera at the ground to use the view', // layers/recentImagery/index.js
  'That point cannot anchor a box', // layers/recentImagery/index.js
  ...[
    [{ west: 170, south: 10, east: -170, north: 20 }, 'too-large'],
    [{ west: 10, south: 80, east: 20, north: 89 }, 'polar'],
    [{ west: 10, south: 10, east: 10, north: 20 }, 'degenerate'],
    [{ west: 10, south: 10, east: 200, north: 20 }, 'invalid'],
    [{ west: Number.NaN, south: 10, east: 20, north: 20 }, 'invalid'],
  ].map(([box, reason]) => {
    const result = validateBox(box);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    return result.message;
  }),
];

test('a dateline box is measured on its short arc', () => {
  assert.equal(
    validateBox({ west: 179, south: 0, east: -179, north: 1 }).ok,
    true,
  );
});

test('en: refusals stay English', () => {
  setLocale('en');
  for (const text of REFUSALS) {
    const shown = localizeNotice(text);
    // Size refusals are rewritten with a non-breaking space before the unit.
    const expected = / km wide/.test(text)
      ? text.replaceAll(' km', '\u00a0km')
      : text;
    assert.equal(shown, expected);
  }
  assert.ok(REFUSALS.includes('Imagery stops at ±85.05° latitude'));
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: box-tool and model refusals are translated`, () => {
    setLocale(locale);
    try {
      for (const text of REFUSALS)
        assert.notEqual(localizeNotice(text), text, `untranslated: ${text}`);
      assert.match(
        localizeNotice('Imagery stops at ±85.05° latitude'),
        /85,05/,
      );
    } finally {
      setLocale('en');
    }
  });
}
