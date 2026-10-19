/** Capture mono PCM directly. No encoded media/container needs to be decoded. */
class LocalPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = null;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'start') {
        this.recording = {
          id: data.id,
          samples: new Float32Array(Math.ceil(sampleRate * 20)),
          length: 0,
        };
      } else if (data.id === this.recording?.id) {
        if (data.type === 'stop') this.finish();
        else if (data.type === 'cancel') this.recording = null;
      }
    };
  }

  finish() {
    const recording = this.recording;
    if (!recording) return;
    this.recording = null;
    const samples = recording.samples.slice(0, recording.length);
    this.port.postMessage({ id: recording.id, samples, sampleRate }, [
      samples.buffer,
    ]);
  }

  process(inputs) {
    const recording = this.recording;
    const input = inputs[0]?.[0];
    if (recording && input) {
      const remaining = recording.samples.length - recording.length;
      const length = Math.min(input.length, remaining);
      recording.samples.set(input.subarray(0, length), recording.length);
      recording.length += length;
      if (recording.length === recording.samples.length) this.finish();
    }
    // Output stays silent: connecting to the destination keeps capture running
    // without playing the microphone back through the speakers.
    return true;
  }
}

registerProcessor('gev-local-pcm', LocalPcmProcessor);
