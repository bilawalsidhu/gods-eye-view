import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeSpectrum, findDirectionalFmPeak } from './spectrum.js';

function toneIq(frequencyOffset, sampleRate, samples = 2_048) {
  const iq = new Uint8Array(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const phase = (2 * Math.PI * frequencyOffset * index) / sampleRate;
    iq[index * 2] = Math.round(127.5 + 100 * Math.cos(phase));
    iq[index * 2 + 1] = Math.round(127.5 + 100 * Math.sin(phase));
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
  const offset = (peakIndex - bins.length / 2) * (sampleRate / bins.length);
  assert.ok(Math.abs(offset - 300_000) < 2_000);
});

test('directional FM seek chooses the nearest rounded station in-band', () => {
  const sampleRate = 2_048_000;
  const bins = analyzeSpectrum(toneIq(300_000, sampleRate));
  const forward = findDirectionalFmPeak(
    bins,
    98_500_000,
    sampleRate,
    1,
    98_500_000,
  );
  assert.equal(forward.frequency, 98_800_000);
  assert.ok(forward.snr > 6);
  assert.equal(
    findDirectionalFmPeak(bins, 98_500_000, sampleRate, -1, 98_500_000),
    null,
  );
});

test('directional FM seek passes over the skipped channel to the next station', () => {
  const sampleRate = 2_048_000;
  const bins = new Float32Array(2_048).fill(-80);
  // Carriers at 98.8 and 99.1 MHz in a frame centred on 98.5 MHz. A carrier
  // 100 kHz away would sit inside the peak test's 150 kHz comparison window.
  for (const offset of [300_000, 600_000]) {
    const index = offset / (sampleRate / bins.length) + bins.length / 2;
    for (let bin = index - 5; bin <= index + 5; bin += 1) bins[bin] = -10;
  }
  const seek = (skipFrequency) =>
    findDirectionalFmPeak(bins, 98_500_000, sampleRate, 1, 98_500_000, {
      skipFrequency,
    })?.frequency;
  assert.equal(seek(undefined), 98_800_000);
  assert.equal(seek(98_800_000), 99_100_000);
  // The skip covers channels up to and including 75 kHz away.
  assert.equal(seek(98_725_000), 99_100_000);
  assert.equal(seek(98_724_999), 98_800_000);
});
