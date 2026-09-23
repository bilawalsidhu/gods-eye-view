class GevSdrAudioPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.volume = 0.8;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'samples' && event.data.samples instanceof Float32Array) {
        this.queue.push(event.data.samples);
        if (this.queue.length > 48) this.queue.splice(0, this.queue.length - 48);
      } else if (event.data?.type === 'volume') {
        this.volume = Math.max(0, Math.min(1, Number(event.data.value) || 0));
      } else if (event.data?.type === 'clear') {
        this.queue.length = 0;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);
    let outputOffset = 0;
    while (outputOffset < output.length && this.queue.length) {
      const samples = this.queue[0];
      const available = samples.length - this.offset;
      const count = Math.min(output.length - outputOffset, available);
      for (let index = 0; index < count; index += 1) {
        output[outputOffset + index] = samples[this.offset + index] * this.volume;
      }
      outputOffset += count;
      this.offset += count;
      if (this.offset >= samples.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('gev-sdr-audio-player', GevSdrAudioPlayer);
