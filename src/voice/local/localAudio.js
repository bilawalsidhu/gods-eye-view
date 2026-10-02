const CAPTURE_WORKLET = `
class GevCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('gev-capture', GevCapture);
`;

// Audio kept from just before a press so the first word is not clipped.
const PRE_ROLL_SECONDS = 0.5;

export const CAPTURE_SAMPLE_RATE = 16000;

/**
 * Microphone capture resampled to 16 kHz. start()/stop() bracket one
 * utterance; stop() resolves with the samples captured in between, plus a
 * short pre-roll from before start().
 */
export async function createMicrophoneCapture({
  getUserMedia = (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
} = {}) {
  const stream = await getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  // Capture at the device rate and resample: a 16 kHz context can deliver
  // silence from some inputs, and not every browser supports one.
  const context = new AudioContext();
  let source;
  let node;
  let sink;
  try {
    const moduleUrl = URL.createObjectURL(
      new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }),
    );
    try {
      await context.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'gev-capture');
    sink = context.createGain();
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    context.close().catch(() => {});
    throw error;
  }
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(context.destination);
  let chunks = [];
  let recording = false;
  let generation = 0;
  const preRoll = [];
  let preRollSamples = 0;
  const preRollLimit = PRE_ROLL_SECONDS * context.sampleRate;
  node.port.onmessage = ({ data }) => {
    if (recording) {
      chunks.push(data);
      return;
    }
    preRoll.push(data);
    preRollSamples += data.length;
    while (preRollSamples - preRoll[0].length > preRollLimit)
      preRollSamples -= preRoll.shift().length;
  };
  return {
    stream,
    get recording() {
      return recording;
    },
    start() {
      generation++;
      chunks = preRoll.splice(0);
      preRollSamples = 0;
      recording = true;
      context.resume().catch(() => {});
    },
    async stop() {
      if (!recording) return new Float32Array(0);
      const utterance = generation;
      const captured = chunks;
      // Let the last render quantum arrive before closing the utterance.
      await new Promise((resolve) => setTimeout(resolve, 60));
      // A new utterance started meanwhile: it owns the recording now.
      if (utterance === generation) {
        recording = false;
        chunks = [];
      }
      const length = captured.reduce((sum, chunk) => sum + chunk.length, 0);
      const audio = new Float32Array(length);
      let offset = 0;
      for (const chunk of captured) {
        audio.set(chunk, offset);
        offset += chunk.length;
      }
      return resampleTo16k(audio, context.sampleRate);
    },
    close() {
      generation++;
      recording = false;
      try {
        source.disconnect();
        node.disconnect();
        sink.disconnect();
      } catch {
        /* already disconnected */
      }
      stream.getTracks().forEach((track) => track.stop());
      context.close().catch(() => {});
    },
  };
}

/**
 * Box-filter resampler to 16 kHz; adequate for speech recognition input.
 * @param {Float32Array} samples
 * @param {number} rate
 */
export function resampleTo16k(samples, rate) {
  if (!rate || rate === CAPTURE_SAMPLE_RATE) return samples;
  const ratio = rate / CAPTURE_SAMPLE_RATE;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let index = 0; index < out.length; index++) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor++) sum += samples[cursor];
    out[index] = sum / Math.max(1, end - start);
  }
  return out;
}

/** Gapless queue for synthesized speech with an interruptible output. */
export function createSpeechPlayer({ onSpeaking, onIdle } = {}) {
  let context = null;
  let gain = null;
  let destination = null;
  let nextStart = 0;
  let playing = 0;
  let generation = 0;
  let idleWaiters = [];

  function settleIdle() {
    onIdle?.();
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function ensure() {
    if (context) return;
    context = new AudioContext();
    destination = context.createMediaStreamDestination();
    connectGain();
  }

  function connectGain() {
    gain = context.createGain();
    gain.connect(context.destination);
    gain.connect(destination);
  }

  return {
    get stream() {
      ensure();
      return destination.stream;
    },
    get speaking() {
      return playing > 0;
    },
    /** Schedules samples; resolves with the delay until they are audible. */
    enqueue(samples, sampleRate) {
      ensure();
      context.resume().catch(() => {});
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      const at = Math.max(context.currentTime + 0.02, nextStart);
      source.start(at);
      nextStart = at + buffer.duration;
      const epoch = generation;
      if (playing++ === 0) onSpeaking?.();
      source.onended = () => {
        if (epoch !== generation) return;
        if (--playing === 0) settleIdle();
      };
      return (at - context.currentTime) * 1000;
    },
    stop() {
      if (!context) return;
      generation++;
      const wasPlaying = playing > 0;
      playing = 0;
      nextStart = 0;
      try {
        gain.disconnect();
      } catch {
        /* already disconnected */
      }
      connectGain();
      if (wasPlaying) settleIdle();
    },
    /** Settles once everything scheduled has finished playing. */
    idle() {
      return playing
        ? new Promise((resolve) => idleWaiters.push(resolve))
        : Promise.resolve();
    },
    close() {
      this.stop();
      context?.close().catch(() => {});
      context = null;
    },
  };
}
