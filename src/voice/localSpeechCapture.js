/**
 * Microphone capture strategies for the local voice adapter. Each returns
 * { kind, start(stream), stop(), pause(), resume(), destroy() } and reports
 * finished utterances through onUtterance(bytes, meta). The adapter never
 * learns how an utterance boundary was decided.
 */

/**
 * Toggle-to-talk capture: record continuously with MediaRecorder and flush one
 * WebM/Opus utterance when stop() is called. Used until VAD assets exist.
 */
export function createRecorderCapture({
  onUtterance,
  onSpeechStart,
  MediaRecorderImpl = globalThis.MediaRecorder,
  timesliceMs = 250,
} = {}) {
  let recorder = null;
  let chunks = [];
  let flushed = false;
  return {
    kind: 'recorder',
    start(stream) {
      if (typeof MediaRecorderImpl !== 'function')
        throw new Error('MediaRecorder is unavailable in this browser');
      const mimeType = pickMimeType(MediaRecorderImpl);
      recorder = new MediaRecorderImpl(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      chunks = [];
      flushed = false;
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener('stop', () => {
        if (flushed) return;
        flushed = true;
        const parts = chunks;
        chunks = [];
        if (!parts.length) return;
        const blob = new Blob(parts, {
          type: recorder?.mimeType || mimeType || 'audio/webm',
        });
        blob.arrayBuffer().then(
          (bytes) =>
            onUtterance?.(bytes, {
              format: 'webm',
              mimeType: blob.type,
              bytes: blob.size,
            }),
          () => {},
        );
      });
      recorder.start(timesliceMs);
      onSpeechStart?.();
    },
    pause() {
      if (recorder?.state === 'recording') recorder.pause();
    },
    resume() {
      if (recorder?.state === 'paused') recorder.resume();
    },
    /** Flush the utterance recorded so far. */
    stop() {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    },
    destroy() {
      try {
        if (recorder && recorder.state !== 'inactive') {
          flushed = true;
          recorder.stop();
        }
      } catch {
        /* no-op */
      }
      recorder = null;
      chunks = [];
    },
  };
}

function pickMimeType(MediaRecorderImpl) {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
  for (const type of candidates) {
    if (MediaRecorderImpl.isTypeSupported?.(type)) return type;
  }
  return '';
}

/**
 * Hands-free capture: Silero VAD (ONNX, WASM) in an AudioWorklet decides
 * utterance boundaries. Each finished utterance arrives as a 16 kHz mono
 * 16-bit WAV ArrayBuffer, so the server reads PCM directly without ffmpeg.
 * Runtime assets are served from node_modules by the Ollama provider plugin
 * under /vendor/vad (see server/providers/ollama.js).
 */
export function createVadCapture({
  onUtterance,
  onSpeechStart,
  onSpeechEnd,
  loadVad = () => import('@ricky0123/vad-web'),
  assetBase = '/vendor/vad/',
  options = {},
} = {}) {
  let vad = null;
  let stream = null;
  let paused = false;
  let destroyed = false;
  return {
    kind: 'vad',
    async start(mediaStream) {
      stream = mediaStream;
      let mod;
      try {
        mod = await loadVad();
      } catch (error) {
        throw new Error(
          `Voice detection failed to load (${error?.message || error})`,
        );
      }
      if (destroyed) return;
      const { MicVAD, utils } = mod;
      vad = await MicVAD.new({
        model: 'v5',
        baseAssetPath: assetBase,
        onnxWASMBasePath: assetBase,
        startOnLoad: false,
        // Share the adapter's stream; never let the library stop our tracks.
        getStream: async () => stream,
        pauseStream: async () => {},
        resumeStream: async () => stream,
        positiveSpeechThreshold: 0.5,
        negativeSpeechThreshold: 0.35,
        redemptionMs: 900,
        preSpeechPadMs: 300,
        minSpeechMs: 350,
        submitUserSpeechOnPause: false,
        ...options,
        onSpeechStart: () => {
          if (!paused) onSpeechStart?.();
        },
        onVADMisfire: () => onSpeechEnd?.({ misfire: true }),
        onSpeechEnd: (audio) => {
          if (paused || destroyed || !audio?.length) return;
          onSpeechEnd?.({ misfire: false });
          // 16-bit PCM (format 1); the library default is 32-bit float.
          onUtterance?.(utils.encodeWAV(audio, 1, 16000, 1, 16), {
            format: 'wav',
            sampleRate: 16000,
            durationMs: Math.round(audio.length / 16),
          });
        },
      });
      if (destroyed) {
        await vad.destroy();
        vad = null;
        return;
      }
      await vad.start();
    },
    pause() {
      paused = true;
      vad?.pause().catch(() => {});
    },
    resume() {
      if (destroyed) return;
      paused = false;
      vad?.start().catch(() => {});
    },
    stop() {
      paused = true;
      vad?.pause().catch(() => {});
    },
    destroy() {
      destroyed = true;
      const current = vad;
      vad = null;
      current?.destroy().catch(() => {});
    },
  };
}
