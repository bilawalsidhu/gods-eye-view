/** Seconds between the two soft "working" ticks. */
const TICK_INTERVAL_S = 1.1;
const TICK_GAIN = 0.035;

/**
 * A quiet, repeating two-note tick that says "still working" when nothing
 * else is audible. It is the floor under spoken progress, never a substitute
 * for it.
 *
 * `available()` gates it on the microphone being muted (push-to-talk after
 * release): with an open microphone a local sound could be heard as user
 * speech and end the turn, so an open-mic session relies on the voice card's
 * visual progress instead.
 * @param {{ isMicrophoneMuted: () => boolean, createContext?: () => AudioContext|null }} options
 */
export function createEarcon({
  isMicrophoneMuted,
  createContext = () => {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    return Context ? new Context() : null;
  },
} = {}) {
  let context = null;
  let timer = null;

  function tick() {
    if (!context) return;
    const start = context.currentTime + 0.01;
    for (const [offset, frequency] of [
      [0, 880],
      [0.09, 1320],
    ]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start + offset);
      gain.gain.linearRampToValueAtTime(TICK_GAIN, start + offset + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.09);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.1);
    }
  }

  return {
    available: () => Boolean(isMicrophoneMuted?.()),
    start() {
      if (timer) return;
      context ||= createContext();
      if (!context) return;
      context.resume?.().catch?.(() => {});
      tick();
      timer = setInterval(tick, TICK_INTERVAL_S * 1000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    dispose() {
      this.stop();
      context?.close?.().catch?.(() => {});
      context = null;
    },
  };
}
