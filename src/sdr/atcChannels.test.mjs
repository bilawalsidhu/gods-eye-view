import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAtcChannel } from './atcChannels.js';

test('25 kHz and 8.33 kHz designators tune to the published carriers', () => {
  for (const [label, frequencyHz, spacingKhz] of [
    ['118.000', 118_000_000, 25],
    ['118.005', 118_000_000, 8.33],
    ['118.010', 118_008_333, 8.33],
    ['118.015', 118_016_667, 8.33],
    ['118.025', 118_025_000, 25],
    ['118.030', 118_025_000, 8.33],
    ['132.035', 132_033_333, 8.33],
    ['136.990', 136_991_667, 8.33],
  ]) {
    assert.deepEqual(parseAtcChannel(label), {
      label,
      frequencyHz,
      spacingKhz,
    });
  }
});

test('manual entry accepts short and comma-decimal channel labels', () => {
  for (const [input, label] of [
    ['118', '118.000'],
    ['121.5', '121.500'],
    [' 118,01 ', '118.010'],
  ]) {
    assert.deepEqual(parseAtcChannel(input), parseAtcChannel(label));
  }
});

test('invalid labels are rejected without rounding to another channel', () => {
  for (const input of [
    '',
    '117.995',
    '118.008333',
    '118.020',
    '118.016',
    '118.0350',
    '136.995',
    '137.000',
    '1.18e2',
    118.01,
    null,
  ]) {
    assert.equal(parseAtcChannel(input), null, String(input));
  }
});
