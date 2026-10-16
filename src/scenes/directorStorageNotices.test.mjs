// Director storage-failure notices and stop reasons must be marked for
// translation and present in every shipped catalog, so es/ru users do not
// get English toasts or Scene status lines. The stop reason itself stays
// English data (it is logged); only the status line translates it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMessages,
  readCatalog,
  shippedLocales,
} from '../../scripts/i18n.mjs';

const NOTICES = [
  'Scene not saved — browser storage unavailable',
  'Scene not saved — existing saved project could not be read. Export edits or import a valid file.',
  'Saved project could not be read; storage preserved. Import a valid file to resume saving.',
  'Scene not saved — {reason}',
  'Stopped',
  'Stopped (Esc)',
  'Stopped by voice',
  'Camera ownership changed',
  'Scene layer turned off',
  'Seeking scene clock',
  'Importing project',
  'Camera move interrupted',
  'Scene media timed out',
];

const messages = extractMessages();

for (const text of NOTICES) {
  test(`Director notice is marked with t()/msg(): ${text}`, () => {
    assert.ok(messages.has(text), `not marked for translation: ${text}`);
  });
  for (const locale of shippedLocales()) {
    test(`${locale} catalog translates: ${text}`, () => {
      const value = readCatalog(locale)[text];
      assert.ok(value, `missing in ${locale}.json`);
      assert.notEqual(value, text);
    });
  }
}
