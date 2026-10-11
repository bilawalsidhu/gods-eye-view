import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSpectrum } from './spectrum.js';
test('arbitrary bin budgets produce finite radix-two spectra without reading absent IQ', () => {
  const iq = new Uint8Array(4096).fill(127);
  for (const [limit, expected] of [
    [1000, 512],
    [2048, 2048],
    [3, 2],
    [512.5, 512],
  ]) {
    const bins = analyzeSpectrum(iq.buffer, limit);
    assert.equal(bins.length, expected);
    assert.ok([...bins].every(Number.isFinite));
  }
  for (const bytes of [0, 1, 2, 3])
    assert.equal(analyzeSpectrum(new Uint8Array(bytes).buffer).length, 0);
  for (const limit of [0, 1, NaN, Infinity, -2])
    assert.throws(() => analyzeSpectrum(iq.buffer, limit), RangeError);
});
