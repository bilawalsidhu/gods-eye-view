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

test('quantities follow the page unit system; metric reads as before', async () => {
  const { setUnitSystem } = await import('../units.js');
  const {
    formatDistance,
    formatHeight,
    formatPrecipitation,
    formatRoadSpeed,
    formatTemperature,
    temperatureValue,
  } = await import('./unitLabels.js');
  setLocale('en');
  const nb = ' ';
  try {
    setUnitSystem('metric');
    assert.equal(formatTemperature(21.6), `22${nb}°C`);
    assert.equal(temperatureValue(21.6), 22);
    assert.equal(formatDistance(850), `850${nb}m`);
    assert.equal(formatDistance(4600), `4.6${nb}km`);
    assert.equal(formatRoadSpeed(42), `42${nb}km/h`);
    assert.equal(formatHeight(120), `120${nb}m`);
    assert.equal(formatPrecipitation(1.24), `1.2${nb}mm`);

    setUnitSystem('imperial');
    assert.equal(formatTemperature(21.6), `71${nb}°F`);
    assert.equal(formatTemperature(-40), `-40${nb}°F`);
    assert.equal(temperatureValue(0), 32);
    assert.equal(formatDistance(250), `820${nb}ft`);
    assert.equal(formatDistance(4600), `2.9${nb}mi`);
    assert.equal(formatRoadSpeed(42), `26${nb}mph`);
    assert.equal(formatHeight(120), `394${nb}ft`);
    assert.equal(formatPrecipitation(25.4), `1.00${nb}in`);
    assert.equal(unitLabel('mi'), 'mi');
    assert.equal(unitLabel('in'), 'in');

    setLocale('ru');
    assert.equal(formatDistance(4600), `2,9${nb}миль`);
    assert.equal(unitLabel('in'), 'дюйм', 'the unit, not the preposition');
  } finally {
    setUnitSystem('metric');
    setLocale('en');
  }
  assert.equal(formatTemperature(Number.NaN), '');
  assert.equal(formatDistance(-1), '');
});
