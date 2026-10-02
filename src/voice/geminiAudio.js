export const GEMINI_INPUT_RATE = 16_000;
export const GEMINI_OUTPUT_RATE = 24_000;

// Averaging decimation to 16 kHz PCM16 in ~100 ms chunks. A 16 kHz AudioContext
// would be simpler, but Firefox refuses to connect a microphone to a context
// whose rate differs from the device's.
const CAPTURE_WORKLET = `
class GevPcm16Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / ${GEMINI_INPUT_RATE};
    this.phase = 0; this.sum = 0; this.count = 0;
    this.chunk = new Int16Array(${GEMINI_INPUT_RATE / 10}); this.length = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels[0]) return true;
    for (let i = 0; i < channels[0].length; i++) {
      // An audio interface may carry the microphone on any one input, so take
      // the loudest channel instead of trusting the first.
      let value = channels[0][i];
      for (let c = 1; c < channels.length; c++)
        if (Math.abs(channels[c][i]) > Math.abs(value)) value = channels[c][i];
      this.sum += value; this.count++; this.phase += 1;
      if (this.phase < this.step) continue;
      this.phase -= this.step;
      const sample = Math.max(-1, Math.min(1, this.sum / this.count));
      this.sum = 0; this.count = 0;
      this.chunk[this.length++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      if (this.length === this.chunk.length) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(${GEMINI_INPUT_RATE / 10}); this.length = 0;
      }
    }
    return true;
  }
}
registerProcessor('gev-pcm16-capture', GevPcm16Capture);
`;

/** Encode raw bytes as base64 without building one giant argument list. */
export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Decode base64 little-endian PCM16 into normalized float samples. */
export function base64Pcm16ToFloat32(data) {
  const binary = atob(data);
  const samples = new Float32Array(binary.length >> 1);
  for (let i = 0; i < samples.length; i++) {
    let value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
    if (value >= 0x8000) value -= 0x10000;
    samples[i] = value / 0x8000;
  }
  return samples;
}

/** Sample rate from a `audio/pcm;rate=24000` MIME type. */
export function pcmRate(mimeType, fallback = GEMINI_OUTPUT_RATE) {
  const rate = Number(/rate=(\d+)/.exec(String(mimeType || ''))?.[1]);
  return Number.isFinite(rate) && rate >= 8000 && rate <= 96_000
    ? rate
    : fallback;
}

/** Microphone capture and gapless playback for one Gemini Live session. */
export function createGeminiAudio({
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContextImpl = globalThis.AudioContext,
  onSpeaker = () => {},
} = {}) {
  let input = null;
  let output = null;
  let stream = null;
  let playhead = 0;
  const playing = new Set();

  return {
    async startCapture(onChunk) {
      stream = await mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      input = new AudioContextImpl();
      const url = URL.createObjectURL(
        new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }),
      );
      try {
        await input.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const source = input.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(input, 'gev-pcm16-capture');
      capture.port.onmessage = (event) => {
        let peak = 0;
        for (const sample of new Int16Array(event.data))
          peak = Math.max(peak, Math.abs(sample));
        onChunk(bytesToBase64(new Uint8Array(event.data)), peak / 0x8000);
      };
      source.connect(capture);
      // A context created after the click's activation lapsed starts suspended
      // and would capture nothing.
      if (input.state === 'suspended') void input.resume().catch(() => {});
      const track = stream.getAudioTracks?.()[0];
      return {
        label: track?.label || '',
        status: () => ({
          context: input?.state,
          sampleRate: input?.sampleRate,
          muted: Boolean(track?.muted),
          track: track?.readyState,
          settings: track?.getSettings?.(),
        }),
      };
    },
    play(data, mimeType) {
      output ||= new AudioContextImpl();
      if (output.state === 'suspended') void output.resume();
      const samples = base64Pcm16ToFloat32(data);
      if (!samples.length) return;
      const buffer = output.createBuffer(1, samples.length, pcmRate(mimeType));
      buffer.copyToChannel(samples, 0);
      const node = output.createBufferSource();
      node.buffer = buffer;
      node.connect(output.destination);
      playhead = Math.max(playhead, output.currentTime + 0.02);
      node.start(playhead);
      playhead += buffer.duration;
      playing.add(node);
      onSpeaker('ai');
      node.onended = () => {
        playing.delete(node);
        if (!playing.size) onSpeaker('idle');
      };
    },
    flush() {
      for (const node of playing) {
        node.onended = null;
        try {
          node.stop();
        } catch {
          /* already stopped */
        }
      }
      playing.clear();
      playhead = 0;
      onSpeaker('idle');
    },
    stop() {
      this.flush();
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      void input?.close().catch(() => {});
      void output?.close().catch(() => {});
      input = output = null;
    },
  };
}
