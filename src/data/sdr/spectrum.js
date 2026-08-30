function nextPowerOfTwo(value) {
  return 2 ** Math.floor(Math.log2(Math.max(2, value)));
}

function fft(real, imag) {
  const length = real.length;
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index >= reversed) continue;
    [real[index], real[reversed]] = [real[reversed], real[index]];
    [imag[index], imag[reversed]] = [imag[reversed], imag[index]];
  }
  for (let size = 2; size <= length; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    for (let start = 0; start < length; start += size) {
      let twiddleReal = 1;
      let twiddleImag = 0;
      for (let index = 0; index < size / 2; index += 1) {
        const even = start + index;
        const odd = even + (size / 2);
        const oddReal = (real[odd] * twiddleReal) - (imag[odd] * twiddleImag);
        const oddImag = (real[odd] * twiddleImag) + (imag[odd] * twiddleReal);
        real[odd] = real[even] - oddReal;
        imag[odd] = imag[even] - oddImag;
        real[even] += oddReal;
        imag[even] += oddImag;
        const nextReal = (twiddleReal * stepReal) - (twiddleImag * stepImag);
        twiddleImag = (twiddleReal * stepImag) + (twiddleImag * stepReal);
        twiddleReal = nextReal;
      }
    }
  }
}

/** Create an FFT-shifted dB power spectrum from interleaved unsigned 8-bit IQ. */
export function analyzeSpectrum(buffer, maxBins = 2_048) {
  const iq = new Uint8Array(buffer);
  const length = Math.min(nextPowerOfTwo(Math.floor(iq.length / 2)), maxBins);
  const real = new Float32Array(length);
  const imag = new Float32Array(length);
  const sampleOffset = Math.max(0, Math.floor((iq.length / 2 - length) / 2));
  for (let index = 0; index < length; index += 1) {
    const window = 0.5 - (0.5 * Math.cos((2 * Math.PI * index) / (length - 1)));
    real[index] = ((iq[(sampleOffset + index) * 2] - 127.5) / 128) * window;
    imag[index] = ((iq[((sampleOffset + index) * 2) + 1] - 127.5) / 128) * window;
  }
  fft(real, imag);
  const bins = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const shifted = (index + (length / 2)) % length;
    const power = ((real[shifted] ** 2) + (imag[shifted] ** 2)) / (length ** 2);
    bins[index] = 10 * Math.log10(power + 1e-12);
  }
  return bins;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? -120;
}

function channelPower(bins, center, radius) {
  let total = 0;
  let count = 0;
  for (let index = Math.max(0, center - radius); index <= Math.min(bins.length - 1, center + radius); index += 1) {
    total += 10 ** (bins[index] / 10);
    count += 1;
  }
  return 10 * Math.log10((total / Math.max(count, 1)) + 1e-12);
}

/** Find the nearest directional broadcast-FM channel peak in one spectrum frame. */
export function findDirectionalFmPeak(
  bins,
  centerFrequency,
  sampleRate,
  direction,
  afterFrequency,
  { minFrequency = 87_500_000, maxFrequency = 108_000_000, thresholdDb = 6 } = {},
) {
  if (!(bins instanceof Float32Array) || bins.length < 16 || !Number.isFinite(sampleRate)) return null;
  const binWidth = sampleRate / bins.length;
  const channelRadius = Math.max(1, Math.round(55_000 / binWidth));
  const comparisonDistance = Math.max(channelRadius + 1, Math.round(150_000 / binWidth));
  const powers = new Float32Array(bins.length);
  for (let index = 0; index < bins.length; index += 1) {
    powers[index] = channelPower(bins, index, channelRadius);
  }
  const noiseFloor = median(powers);
  const candidates = [];
  const frameMin = centerFrequency - (sampleRate / 2);
  const frameMax = centerFrequency + (sampleRate / 2);
  const firstChannel = Math.ceil(Math.max(minFrequency, frameMin) / 100_000) * 100_000;
  const lastChannel = Math.floor(Math.min(maxFrequency, frameMax) / 100_000) * 100_000;
  for (let frequency = firstChannel; frequency <= lastChannel; frequency += 100_000) {
    if (direction > 0 && frequency <= afterFrequency + 75_000) continue;
    if (direction < 0 && frequency >= afterFrequency - 75_000) continue;
    const index = Math.round((frequency - centerFrequency) / binWidth + (bins.length / 2));
    if (index < comparisonDistance || index >= bins.length - comparisonDistance) continue;
    const power = powers[index];
    if (power - noiseFloor < thresholdDb) continue;
    if (power < powers[index - comparisonDistance] || power < powers[index + comparisonDistance]) continue;
    candidates.push({ frequency, snr: power - noiseFloor, power });
  }
  candidates.sort((a, b) => (
    Math.abs(a.frequency - afterFrequency) - Math.abs(b.frequency - afterFrequency)
      || b.snr - a.snr
  ));
  return candidates[0] || null;
}
