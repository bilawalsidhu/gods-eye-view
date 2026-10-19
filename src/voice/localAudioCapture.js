/** A recording is raw Float32 PCM, never MediaRecorder's partial WebM/Opus data. */
export async function createLocalPcmRecorder(context, source, onError) {
  if (!context.audioWorklet || !globalThis.AudioWorkletNode)
    throw new Error(
      'Microphone capture requires AudioWorklet on localhost or HTTPS.',
    );
  await context.audioWorklet.addModule(
    // Keep a same-origin script URL in production; CSP intentionally blocks
    // data: scripts, which Vite would otherwise inline for this small file.
    new URL('./localAudioWorklet.js?no-inline', import.meta.url),
  );
  if (context.state === 'closed')
    throw new DOMException('Capture stopped', 'AbortError');
  const node = new AudioWorkletNode(context, 'gev-local-pcm', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
  });
  let serial = 0,
    capture = null,
    closed = false;
  node.port.onmessage = ({ data }) => {
    if (!capture || capture.id !== data.id || closed) return;
    const callback = capture.onStop;
    capture = null;
    callback(data.samples, data.sampleRate);
  };
  node.onprocessorerror = () =>
    onError(
      new Error('Microphone processing failed. Restart voice to try again.'),
    );
  source.connect(node);
  node.connect(context.destination);
  const cancel = () => {
    if (!capture) return;
    node.port.postMessage({ type: 'cancel', id: capture.id });
    capture = null;
  };
  return {
    get state() {
      return capture?.state || 'inactive';
    },
    start(onStop) {
      if (closed || capture) return;
      capture = { id: ++serial, state: 'recording', onStop };
      node.port.postMessage({ type: 'start', id: capture.id });
    },
    stop() {
      if (!capture || capture.state !== 'recording') return;
      capture.state = 'stopping';
      node.port.postMessage({ type: 'stop', id: capture.id });
    },
    cancel,
    close() {
      if (closed) return;
      cancel();
      closed = true;
      node.port.onmessage = null;
      node.onprocessorerror = null;
      node.port.close();
      try {
        source.disconnect(node);
      } catch (error) {
        // Session teardown may already have disconnected the source while
        // addModule was pending.
        if (error.name !== 'InvalidAccessError') throw error;
      }
      node.disconnect();
    },
  };
}

/** Ignore accidental taps, disconnected microphones and silence before Whisper. */
export function hasLocalSpeech(samples, sampleRate) {
  if (
    !samples?.length ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    samples.length < sampleRate * 0.2
  )
    return false;
  let energy = 0;
  for (const value of samples) {
    if (!Number.isFinite(value)) return false;
    energy += value * value;
  }
  return energy / samples.length >= 0.002 ** 2;
}

/** Web Audio resamples microphone PCM to the 16 kHz input expected by Whisper. */
export async function localSpeechSamples(samples, sampleRate) {
  if (sampleRate === 16000) return samples;
  const offline = new OfflineAudioContext(
    1,
    Math.ceil((samples.length * 16000) / sampleRate),
    16000,
  );
  const buffer = offline.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}
