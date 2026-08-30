import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeSpectrum, findDirectionalFmPeak } from './spectrum.js';

function toneIq(frequencyOffset, sampleRate, samples = 2_048) {
  const iq = new Uint8Array(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const phase = (2 * Math.PI * frequencyOffset * index) / sampleRate;
    iq[index * 2] = Math.round(127.5 + (100 * Math.cos(phase)));
    iq[(index * 2) + 1] = Math.round(127.5 + (100 * Math.sin(phase)));
  }
  return iq.buffer;
}

test('FFT-shifted spectrum preserves the sign and offset of a complex tone', () => {
  const sampleRate = 2_048_000;
  const bins = analyzeSpectrum(toneIq(300_000, sampleRate));
  let peakIndex = 0;
  for (let index = 1; index < bins.length; index += 1) {
    if (bins[index] > bins[peakIndex]) peakIndex = index;
  }
  const offset = (peakIndex - (bins.length / 2)) * (sampleRate / bins.length);
  assert.ok(Math.abs(offset - 300_000) < 2_000);
});

test('directional FM seek chooses the nearest rounded station in-band', () => {
  const sampleRate = 2_048_000;
  const bins = analyzeSpectrum(toneIq(300_000, sampleRate));
  const forward = findDirectionalFmPeak(bins, 98_500_000, sampleRate, 1, 98_500_000);
  assert.equal(forward.frequency, 98_800_000);
  assert.ok(forward.snr > 6);
  assert.equal(findDirectionalFmPeak(bins, 98_500_000, sampleRate, -1, 98_500_000), null);
});
