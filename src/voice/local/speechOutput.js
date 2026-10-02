import { createSpeechPlayer } from './localAudio.js';

/**
 * Speech output engines share one interface so the voice can be swapped:
 *   speak(text) → Promise<{delayMs, ms} | null> once the sentence is queued,
 *   idle() → Promise that settles when everything queued has been heard,
 *   stop() cancels queued and playing speech, close() releases resources.
 */

/** Picks an English on-device voice, preferring US English. */
export function pickOnDeviceVoice(voices = [], language = 'en-US') {
  const local = voices.filter((voice) => voice.localService);
  const base = language.split('-')[0].toLowerCase();
  return (
    local.find((voice) => voice.lang === language && voice.default) ||
    local.find((voice) => voice.lang === language) ||
    local.find((voice) => voice.lang?.toLowerCase().startsWith(base)) ||
    null
  );
}

/** Kokoro through the synthesis worker and a gapless player. */
export function createKokoroOutput({ client, onSpeaking, onIdle }) {
  const player = createSpeechPlayer({ onSpeaking, onIdle });
  // Audio synthesized for a sentence queued before stop() or close() is
  // dropped, even if the worker answers after the flush.
  let generation = 0;
  return {
    id: 'kokoro',
    get stream() {
      return player.stream;
    },
    async speak(text) {
      const epoch = generation;
      const audio = await client.synthesize(text).catch(() => null);
      if (!audio || audio.skipped || epoch !== generation) return null;
      return {
        delayMs: player.enqueue(audio.samples, audio.sampleRate),
        ms: audio.ms,
      };
    },
    idle: () => player.idle(),
    stop() {
      generation++;
      client.flush();
      player.stop();
    },
    close() {
      generation++;
      player.close();
    },
  };
}

/**
 * The browser's speech synthesis restricted to voices that report
 * `localService`, so text is not sent to a speech service.
 */
export function createSystemOutput({
  synthesis = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  voice,
  onSpeaking,
  onIdle,
}) {
  let pending = 0;
  let generation = 0;
  let waiters = [];
  const settle = () => {
    if (pending) return;
    onIdle?.();
    const resolved = waiters;
    waiters = [];
    for (const resolve of resolved) resolve();
  };
  return {
    id: 'system',
    stream: null,
    // The platform queues utterances itself, so speak() returns at once and
    // audible timing is not reported.
    async speak(text) {
      const epoch = generation;
      const utterance = new Utterance(text);
      utterance.voice = voice;
      utterance.lang = voice?.lang || 'en-US';
      const finish = () => {
        if (epoch !== generation) return;
        pending = Math.max(0, pending - 1);
        settle();
      };
      utterance.onstart = () => {
        if (epoch === generation) onSpeaking?.();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      pending++;
      synthesis.speak(utterance);
      return { delayMs: null, ms: 0 };
    },
    idle() {
      return pending
        ? new Promise((resolve) => waiters.push(resolve))
        : Promise.resolve();
    },
    stop() {
      generation++;
      pending = 0;
      synthesis.cancel();
      settle();
    },
    close() {
      this.stop();
    },
  };
}

/** No speech: replies appear on screen only. */
export function createSilentOutput() {
  return {
    id: 'none',
    stream: null,
    speak: async () => null,
    idle: () => Promise.resolve(),
    stop() {},
    close() {},
  };
}

/** Waits for the browser's voice list, which loads asynchronously. */
export function loadSystemVoices(
  synthesis = globalThis.speechSynthesis,
  { timeoutMs = 1500 } = {},
) {
  if (!synthesis) return Promise.resolve([]);
  const voices = synthesis.getVoices();
  if (voices.length) return Promise.resolve(voices);
  return new Promise((resolve) => {
    const done = () => {
      synthesis.removeEventListener?.('voiceschanged', done);
      resolve(synthesis.getVoices());
    };
    synthesis.addEventListener?.('voiceschanged', done);
    setTimeout(done, timeoutMs);
  });
}
