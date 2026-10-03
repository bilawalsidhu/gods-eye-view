/** PCM microphone capture. Only explicitly enabled frames leave this processor. */
class GeminiCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.samples = new Int16Array(1024);
    this.length = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.enabled === true && !this.enabled)
        this.port.postMessage({ type: 'start' });
      if (data?.enabled === false && this.enabled) {
        this.flush();
        this.port.postMessage({ type: 'end' });
      }
      this.enabled = data?.enabled === true;
      if (!this.enabled) this.length = 0;
    };
  }
  flush() {
    if (!this.length) return;
    const buffer = new ArrayBuffer(this.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < this.length; i++)
      view.setInt16(i * 2, this.samples[i], true);
    this.port.postMessage({ type: 'audio', buffer }, [buffer]);
    this.length = 0;
  }
  process(inputs) {
    if (!this.enabled) return true;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      const value = Math.max(-1, Math.min(1, sample));
      this.samples[this.length++] = Math.round(
        value * (value < 0 ? 32768 : 32767),
      );
      if (this.length === this.samples.length) this.flush();
    }
    return true;
  }
}
registerProcessor('gev-gemini-capture', GeminiCaptureProcessor);
