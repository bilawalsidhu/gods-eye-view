const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_QUEUED_SECONDS = 60;

export function pcmBytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function decodeGeminiPcm(data, mimeType = 'audio/pcm;rate=24000') {
  if (
    typeof data !== 'string' ||
    data.length > Math.ceil((MAX_AUDIO_BYTES * 4) / 3)
  )
    throw new Error('Gemini returned an oversized audio chunk');
  const match = /^audio\/pcm(?:;rate=(\d+))?$/.exec(mimeType);
  if (!match) throw new Error('Gemini returned an unsupported audio format');
  const sampleRate = Number(match[1] || 24000);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000)
    throw new Error('Gemini returned an invalid audio sample rate');
  const binary = atob(data);
  if (!binary.length || binary.length % 2)
    throw new Error('Gemini returned incomplete PCM audio');
  const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(bytes.length / 2);
  for (let index = 0; index < samples.length; index++)
    samples[index] = view.getInt16(index * 2, true) / 32768;
  return { samples, sampleRate };
}

/** Own capture and playback independently from the Live protocol. */
export function createGeminiAudio({
  onAudioStart,
  onAudio,
  onAudioEnd,
  onDrain,
  onError,
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
  AudioWorkletNodeClass = globalThis.AudioWorkletNode,
} = {}) {
  if (!AudioContextClass || !AudioWorkletNodeClass)
    throw new Error('This browser does not support Gemini microphone audio');
  const context = new AudioContextClass({ sampleRate: 16000 });
  // Called synchronously by the mic gesture, before token/network awaits.
  const resumed = context.resume();
  let closed = false;
  let capture = null;
  let microphone = null;
  let mute = null;
  let nextTime = 0;
  let inputChunks = 0;
  let inputPeak = 0;
  let nonSilentInputChunks = 0;
  let outputChunks = 0;
  let outputSamples = 0;
  let completedOutputSamples = 0;
  let discardedOutputSamples = 0;
  const sources = new Map();
  const output = context.createGain();
  const meter = context.createMediaStreamDestination();
  output.connect(context.destination);
  output.connect(meter);

  function clearPlayback() {
    const oldSources = [...sources];
    sources.clear();
    nextTime = context.currentTime;
    for (const [source, sampleCount] of oldSources) {
      discardedOutputSamples += sampleCount;
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* Already ended. */
      }
      source.disconnect();
    }
  }

  return {
    outputStream: meter.stream,
    get pending() {
      return sources.size > 0;
    },
    async initialize(signal) {
      try {
        await Promise.all([
          resumed,
          context.audioWorklet.addModule(
            new URL('./geminiCaptureWorklet.js', import.meta.url),
          ),
        ]);
        signal?.throwIfAborted();
        if (closed) throw new DOMException('Voice stopped', 'AbortError');
      } catch (error) {
        if (!closed) this.close();
        throw error;
      }
    },
    connectMicrophone(stream, enabled) {
      if (closed) throw new DOMException('Voice stopped', 'AbortError');
      capture = new AudioWorkletNodeClass(context, 'gev-gemini-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      capture.port.onmessage = ({ data }) => {
        if (closed) return;
        try {
          if (data?.type === 'audio' && data.buffer instanceof ArrayBuffer) {
            inputChunks++;
            const pcm = new DataView(data.buffer);
            let peak = 0;
            for (let index = 0; index + 1 < pcm.byteLength; index += 2)
              peak = Math.max(
                peak,
                Math.abs(pcm.getInt16(index, true)) / 32768,
              );
            inputPeak = Math.max(inputPeak, peak);
            if (peak >= 0.01) nonSilentInputChunks++;
            onAudio?.({
              data: pcmBytesToBase64(data.buffer),
              mimeType: `audio/pcm;rate=${context.sampleRate}`,
            });
          } else if (data?.type === 'start') onAudioStart?.();
          else if (data?.type === 'end') onAudioEnd?.();
        } catch (error) {
          onError?.(error);
        }
      };
      capture.onprocessorerror = () =>
        onError?.(new Error('Microphone audio processing failed'));
      microphone = context.createMediaStreamSource(stream);
      mute = context.createGain();
      mute.gain.value = 0;
      capture.port.postMessage({ enabled: Boolean(enabled) });
      microphone.connect(capture);
      capture.connect(mute);
      mute.connect(context.destination);
    },
    setMicrophoneEnabled(enabled) {
      capture?.port.postMessage({ enabled: Boolean(enabled) });
    },
    play(data, mimeType) {
      if (closed) return;
      const { samples, sampleRate } = decodeGeminiPcm(data, mimeType);
      const start = Math.max(context.currentTime + 0.02, nextTime);
      if (
        start + samples.length / sampleRate - context.currentTime >
        MAX_QUEUED_SECONDS
      )
        throw new Error(
          'Gemini audio playback fell behind. Reconnect to continue.',
        );
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(output);
      sources.set(source, samples.length);
      source.onended = () => {
        if (!sources.delete(source)) return;
        completedOutputSamples += samples.length;
        source.disconnect();
        if (!closed && !sources.size) onDrain?.();
      };
      nextTime = start + buffer.duration;
      outputChunks++;
      outputSamples += samples.length;
      source.start(start);
    },
    clearPlayback,
    diagnostics() {
      return {
        inputChunks,
        inputPeak,
        nonSilentInputChunks,
        outputChunks,
        outputSamples,
        completedOutputSamples,
        discardedOutputSamples,
        queuedSeconds: Math.max(0, nextTime - context.currentTime),
        contextState: context.state,
      };
    },
    close() {
      if (closed) return;
      closed = true;
      clearPlayback();
      if (capture) {
        capture.port.onmessage = null;
        capture.port.close();
        capture.disconnect();
      }
      microphone?.disconnect();
      mute?.disconnect();
      output.disconnect();
      meter.disconnect();
      meter.stream.getTracks?.().forEach((track) => track.stop());
      return context.close().then(
        () => true,
        () => false,
      );
    },
  };
}
