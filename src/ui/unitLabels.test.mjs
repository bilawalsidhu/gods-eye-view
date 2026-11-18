import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';
import { formatQuantity, formatScaleLabel, unitLabel } from './unitLabels.js';

test('English readings and scales read exactly as the unit ids', () => {
  setLocale('en');
  assert.equal(unitLabel('km/h'), 'km/h');
  assert.equal(unitLabel('°C'), '°C');
  assert.equal(unitLabel('dBZ'), 'dBZ');
  assert.equal(unitLabel(''), '');
  assert.equal(formatQuantity(95, 'kt'), '95 kt');
  assert.equal(formatQuantity(1006, 'hPa'), '1006 hPa');
  assert.equal(
    formatQuantity(22, 'km/h', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
    '22.0 km/h',
  );
  assert.deepEqual(
    ['0.1', '-40', '1050+', '300+', 'Calm'].map(formatScaleLabel),
    ['0.1', '-40', '1050+', '300+', 'Calm'],
  );
});

test('other languages get their decimal separator and no digit grouping', () => {
  try {
    setLocale('ru');
    assert.match(
      formatQuantity(22, 'km/h', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
      /^22,0 \S+$/,
    );
    assert.match(formatQuantity(1050, 'hPa'), /^1050 /);
    assert.deepEqual(['0.1', '-40', '1050+'].map(formatScaleLabel), [
      '0,1',
      '-40',
      '1050+',
    ]);
  } finally {
    setLocale('en');
  }
});

test('Japanese unit words follow the number directly; symbols keep the space', () => {
  try {
    setLocale('ja');
    assert.equal(formatQuantity(5, 'min'), '5分');
    assert.equal(formatQuantity(1, 'h'), '1時間');
    assert.equal(formatQuantity(95, 'kt'), '95\u00a0kt');
  } finally {
    setLocale('en');
  }
});
