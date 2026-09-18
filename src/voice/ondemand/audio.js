/**
 * src/voice/ondemand/audio.js — microphone capture, energy-based silence
 * detection and answer playback for the OnDemand voice pipeline.
 *
 * The pure part (`createSilenceDetector`) is unit-tested; the browser part
 * (`createBrowserRecorder`, `createBrowserPlayer`) wraps getUserMedia +
 * MediaRecorder + an AnalyserNode and HTMLAudioElement, with every platform
 * constructor injectable so the pipeline tests can substitute fakes.
 *
 * Recorder contract (what pipeline.js depends on):
 *   const capture = await recorder.start({ onSpeech, onSilence });
 *   const blob = await capture.stop();      // null when nothing was captured
 *   capture.cancel();                       // discard
 *   const monitor = await recorder.monitor({ onSpeech }); monitor.stop();
 *
 * Player contract:
 *   await player.play({ kind:'blob', blob } | { kind:'url', url }, { signal })
 *   player.stop();
 */

export const SILENCE_DEFAULTS = Object.freeze({
  silenceMs: 1200, // stop ≈1.2 s after the speaker goes quiet
  speechThreshold: 0.012, // RMS (0..1) above which a frame counts as speech
  minSpeechMs: 120, // sustained frames before "speech started" fires
  bargeThreshold: 0.045, // higher bar during playback (speaker bleed)
  bargeHoldMs: 260,
  tickMs: 50,
});

/**
 * Pure RMS-driven speech/silence state machine.
 * feed(rms, t) → 'speech' once when speech starts, 'stop' once after
 * `silenceMs` of quiet FOLLOWING speech, otherwise null. Never emits 'stop'
 * before any speech was heard (the 12 s utterance cap covers that case).
 */
export function createSilenceDetector({
  silenceMs = SILENCE_DEFAULTS.silenceMs,
  threshold = SILENCE_DEFAULTS.speechThreshold,
  minSpeechMs = SILENCE_DEFAULTS.minSpeechMs,
} = {}) {
  let speechCandidateAt = null;
  let lastSpeechAt = null;
  let spoke = false;
  let stopped = false;
  return {
    feed(rms, t) {
      if (stopped) return null;
      if (rms >= threshold) {
        if (speechCandidateAt === null) speechCandidateAt = t;
        lastSpeechAt = t;
        if (!spoke && t - speechCandidateAt >= minSpeechMs) {
          spoke = true;
          return 'speech';
        }
        return null;
      }
      if (!spoke) {
        speechCandidateAt = null;
        return null;
      }
      if (lastSpeechAt !== null && t - lastSpeechAt >= silenceMs) {
        stopped = true;
        return 'stop';
      }
      return null;
    },
    get spoke() {
      return spoke;
    },
    reset() {
      speechCandidateAt = null;
      lastSpeechAt = null;
      spoke = false;
      stopped = false;
    },
  };
}

/** Root-mean-square of a float time-domain buffer (-1..1). */
export function rmsOf(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function pickMimeType(MediaRecorderImpl) {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  if (typeof MediaRecorderImpl?.isTypeSupported !== 'function') return '';
  return (
    candidates.find((type) => MediaRecorderImpl.isTypeSupported(type)) || ''
  );
}

/**
 * Browser recorder: getUserMedia({audio:true}) → MediaRecorder + AnalyserNode.
 */
export function createBrowserRecorder({
  navigator: nav = globalThis.navigator,
  MediaRecorder: MediaRecorderImpl = globalThis.MediaRecorder,
  AudioContext: AudioContextImpl = globalThis.AudioContext ||
    globalThis.webkitAudioContext,
  setInterval: setTick = globalThis.setInterval?.bind(globalThis),
  clearInterval: clearTick = globalThis.clearInterval?.bind(globalThis),
  now = () =>
    typeof performance !== 'undefined' ? performance.now() : Date.now(),
  silenceMs = SILENCE_DEFAULTS.silenceMs,
  speechThreshold = SILENCE_DEFAULTS.speechThreshold,
  bargeThreshold = SILENCE_DEFAULTS.bargeThreshold,
  bargeHoldMs = SILENCE_DEFAULTS.bargeHoldMs,
  tickMs = SILENCE_DEFAULTS.tickMs,
} = {}) {
  async function openStream() {
    if (!nav?.mediaDevices?.getUserMedia)
      throw new Error('Microphone access is not available in this browser');
    return nav.mediaDevices.getUserMedia({ audio: true });
  }

  function attachAnalyser(stream) {
    if (typeof AudioContextImpl !== 'function') return null;
    try {
      const context = new AudioContextImpl();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      return {
        rms() {
          if (typeof analyser.getFloatTimeDomainData === 'function') {
            analyser.getFloatTimeDomainData(buffer);
            return rmsOf(buffer);
          }
          const bytes = new Uint8Array(analyser.fftSize);
          analyser.getByteTimeDomainData(bytes);
          let sum = 0;
          for (let i = 0; i < bytes.length; i += 1) {
            const v = (bytes[i] - 128) / 128;
            sum += v * v;
          }
          return Math.sqrt(sum / bytes.length);
        },
        close() {
          try {
            source.disconnect();
          } catch {
            // already disconnected
          }
          return context.close?.().catch?.(() => {});
        },
      };
    } catch {
      return null;
    }
  }

  function stopTracks(stream) {
    for (const track of stream?.getTracks?.() || []) {
      try {
        track.stop();
      } catch {
        // already stopped
      }
    }
  }

  return {
    async start({ onSpeech, onSilence } = {}) {
      const stream = await openStream();
      if (typeof MediaRecorderImpl !== 'function') {
        stopTracks(stream);
        throw new Error('MediaRecorder is not available in this browser');
      }
      const mimeType = pickMimeType(MediaRecorderImpl);
      const recorder = new MediaRecorderImpl(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      const chunks = [];
      recorder.addEventListener?.('dataavailable', (event) => {
        if (event?.data && event.data.size > 0) chunks.push(event.data);
      });
      if (!recorder.addEventListener) {
        recorder.ondataavailable = (event) => {
          if (event?.data && event.data.size > 0) chunks.push(event.data);
        };
      }
      const analyser = attachAnalyser(stream);
      const detector = createSilenceDetector({
        silenceMs,
        threshold: speechThreshold,
      });
      let ticker = null;
      if (analyser && setTick) {
        ticker = setTick(() => {
          const verdict = detector.feed(analyser.rms(), now());
          if (verdict === 'speech') onSpeech?.();
          else if (verdict === 'stop') onSilence?.();
        }, tickMs);
      }
      recorder.start(250);
      let finished = null;
      const finish = () =>
        new Promise((resolve) => {
          if (ticker !== null) clearTick(ticker);
          ticker = null;
          const settle = () => {
            stopTracks(stream);
            analyser?.close();
            const type = recorder.mimeType || mimeType || 'audio/webm';
            resolve(chunks.length ? new Blob(chunks, { type }) : null);
          };
          if (recorder.state === 'inactive') {
            settle();
            return;
          }
          const onStop = () => settle();
          if (recorder.addEventListener)
            recorder.addEventListener('stop', onStop, { once: true });
          else recorder.onstop = onStop;
          try {
            recorder.stop();
          } catch {
            settle();
          }
        });
      return {
        mimeType,
        stop() {
          finished ||= finish();
          return finished;
        },
        cancel() {
          finished ||= finish();
          return finished.then(() => null);
        },
        get spoke() {
          return detector.spoke;
        },
      };
    },

    /** Barge-in listener used while the answer plays: higher threshold + hold. */
    async monitor({ onSpeech } = {}) {
      const stream = await openStream();
      const analyser = attachAnalyser(stream);
      let above = null;
      let fired = false;
      const ticker =
        analyser && setTick
          ? setTick(() => {
              const t = now();
              if (analyser.rms() >= bargeThreshold) {
                if (above === null) above = t;
                if (!fired && t - above >= bargeHoldMs) {
                  fired = true;
                  onSpeech?.();
                }
              } else above = null;
            }, tickMs)
          : null;
      return {
        stop() {
          if (ticker !== null) clearTick(ticker);
          stopTracks(stream);
          analyser?.close();
        },
      };
    },
  };
}

/** HTMLAudioElement playback of a Blob or hosted URL; resolves when ended. */
export function createBrowserPlayer({
  Audio: AudioImpl = globalThis.Audio,
  URL: URLImpl = globalThis.URL,
} = {}) {
  let current = null;
  const stop = () => {
    const active = current;
    current = null;
    if (!active) return;
    try {
      active.audio.pause();
      active.audio.src = '';
    } catch {
      // ignore
    }
    if (active.objectUrl) {
      try {
        URLImpl.revokeObjectURL(active.objectUrl);
      } catch {
        // ignore
      }
    }
    active.resolve({ interrupted: true });
  };
  return {
    play(source, { signal } = {}) {
      stop();
      if (typeof AudioImpl !== 'function')
        return Promise.reject(new Error('Audio playback is not available'));
      return new Promise((resolve, reject) => {
        let objectUrl = null;
        let src = source?.url || '';
        if (source?.kind === 'blob' && source.blob) {
          objectUrl = URLImpl.createObjectURL(source.blob);
          src = objectUrl;
        }
        const audio = new AudioImpl(src);
        const entry = { audio, objectUrl, resolve };
        current = entry;
        const finish = (value) => {
          if (current === entry) {
            current = null;
            if (objectUrl) {
              try {
                URLImpl.revokeObjectURL(objectUrl);
              } catch {
                // ignore
              }
            }
          }
          resolve(value);
        };
        audio.addEventListener?.(
          'ended',
          () => finish({ interrupted: false }),
          {
            once: true,
          },
        );
        audio.addEventListener?.(
          'error',
          () => {
            if (current === entry) current = null;
            reject(new Error('Audio playback failed'));
          },
          { once: true },
        );
        if (!audio.addEventListener) {
          audio.onended = () => finish({ interrupted: false });
          audio.onerror = () => reject(new Error('Audio playback failed'));
        }
        signal?.addEventListener?.('abort', () => stop(), { once: true });
        const started = audio.play?.();
        if (started && typeof started.catch === 'function')
          started.catch((error) => {
            if (current === entry) current = null;
            reject(error);
          });
      });
    },
    stop,
    get playing() {
      return current !== null;
    },
  };
}
