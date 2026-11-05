const OUTPUT_RATE = 16000;
const FILTER_TAPS = 64;
const FILTER_PHASES = 128;

// A causal, windowed-sinc low-pass filter avoids folding device frequencies
// above 8 kHz into speech. Precompute phases; process allocates no filter data.
function resamplingFilters(inputRate) {
  const cutoff = 0.45 * Math.min(1, OUTPUT_RATE / inputRate);
  const filters = new Float32Array(FILTER_TAPS * FILTER_PHASES);
  for (let phase = 0; phase < FILTER_PHASES; phase++) {
    let total = 0;
    for (let tap = 0; tap < FILTER_TAPS; tap++) {
      const distance = tap - (FILTER_TAPS - 1) / 2 - phase / FILTER_PHASES;
      const sinc =
        distance === 0
          ? 2 * cutoff
          : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
      const window =
        0.5 - 0.5 * Math.cos((2 * Math.PI * tap) / (FILTER_TAPS - 1));
      const weight = sinc * window;
      filters[phase * FILTER_TAPS + tap] = weight;
      total += weight;
    }
    for (let tap = 0; tap < FILTER_TAPS; tap++)
      filters[phase * FILTER_TAPS + tap] /= total;
  }
  return filters;
}

/** PCM microphone capture. Only explicitly enabled frames leave this processor. */
class GeminiCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.captureId = null;
    this.samples = new Int16Array(1024);
    this.length = 0;
    this.inputRate = sampleRate;
    this.filters =
      this.inputRate === OUTPUT_RATE ? null : resamplingFilters(this.inputRate);
    this.history = new Float32Array(FILTER_TAPS);
    this.resetResampler();
    this.port.onmessage = ({ data }) => {
      if (data?.enabled === true) {
        if (
          this.enabled ||
          !Number.isSafeInteger(data.captureId) ||
          data.captureId <= 0
        )
          return;
        this.captureId = data.captureId;
        this.resetResampler();
        this.enabled = true;
        this.port.postMessage({ type: 'start', captureId: this.captureId });
      } else if (
        data?.enabled === false &&
        this.enabled &&
        data.captureId === this.captureId
      ) {
        this.flush();
        this.port.postMessage({ type: 'end', captureId: this.captureId });
        this.enabled = false;
        this.captureId = null;
        this.length = 0;
        // Do not drain filter tails into a later physical microphone capture.
        this.resetResampler();
      }
    };
  }
  resetResampler() {
    this.phase = 0;
    this.historyIndex = 0;
    this.history.fill(0);
  }
  appendSample(sample) {
    const value = Math.max(-1, Math.min(1, sample));
    this.samples[this.length++] = Math.round(
      value * (value < 0 ? 32768 : 32767),
    );
    if (this.length === this.samples.length) this.flush();
  }
  flush() {
    if (!this.length) return;
    const buffer = new ArrayBuffer(this.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < this.length; i++)
      view.setInt16(i * 2, this.samples[i], true);
    this.port.postMessage(
      { type: 'audio', buffer, captureId: this.captureId },
      [buffer],
    );
    this.length = 0;
  }
  process(inputs) {
    if (!this.enabled) return true;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      if (!this.filters) {
        this.appendSample(sample);
        continue;
      }
      this.history[this.historyIndex] = sample;
      this.historyIndex = (this.historyIndex + 1) % FILTER_TAPS;
      this.phase += OUTPUT_RATE;
      while (this.phase >= this.inputRate) {
        this.phase -= this.inputRate;
        const phase = Math.min(
          FILTER_PHASES - 1,
          Math.floor((this.phase * FILTER_PHASES) / OUTPUT_RATE),
        );
        let value = 0;
        for (let tap = 0; tap < FILTER_TAPS; tap++) {
          const index =
            (this.historyIndex - 1 - tap + FILTER_TAPS) % FILTER_TAPS;
          value +=
            this.history[index] * this.filters[phase * FILTER_TAPS + tap];
        }
        this.appendSample(value);
      }
    }
    return true;
  }
}
registerProcessor('gev-gemini-capture', GeminiCaptureProcessor);
