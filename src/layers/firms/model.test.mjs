import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocale, setLocale } from '../../i18n/index.js';
import { createModel } from './model.js';

const HOUR_MS = 3600000;

test('a fire age that rounds to 48 hours reads in days, as 48 hours does', () => {
  const previousLocale = getLocale();
  const { formatAge, formatAgeLabel } = createModel({
    services: { anchors: {} },
  });
  try {
    setLocale('en');
    assert.equal(formatAge(47.4 * HOUR_MS), '47h');
    assert.equal(formatAge(47.6 * HOUR_MS), '2d');
    assert.equal(formatAge(48 * HOUR_MS), '2d');
    assert.equal(formatAgeLabel(47.4 * HOUR_MS), '47h');
    assert.equal(formatAgeLabel(47.6 * HOUR_MS), formatAgeLabel(48 * HOUR_MS));
    assert.equal(formatAgeLabel(48 * HOUR_MS), '2d');
  } finally {
    setLocale(previousLocale);
  }
});
