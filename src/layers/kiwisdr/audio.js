/**
 * Gapless playback of 12 kHz mono chunks through Web Audio.
 *
 * Chunks are scheduled back to back on the audio clock behind a small jitter
 * buffer; the browser resamples to the device rate. If the network stalls and
 * the queue runs dry the playhead resynchronises instead of bursting.
 */
export function createKiwiAudio({
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
  jitterSeconds = 0.35,
  maxLeadSeconds = 1.5,
} = {}) {
  let context = null;
  let gain = null;
  let playhead = 0;
  let volume = 0.8;
  let muted = false;
  let analyser = null;

  function ensure() {
    if (context) return context;
    if (!AudioContextImpl) throw new Error('Web Audio is not available');
    context = new AudioContextImpl();
    gain = context.createGain();
    gain.gain.value = muted ? 0 : volume;
    analyser = context.createAnalyser?.() ?? null;
    if (analyser) {
      analyser.fftSize = 256;
      gain.connect(analyser);
    }
    gain.connect(context.destination);
    return context;
  }

  return {
    /** Output rate the server should be told about. */
    get sampleRate() {
      return ensure().sampleRate;
    },
    /** Must run from a user gesture the first time. */
    async resume() {
      const ctx = ensure();
      if (ctx.state === 'suspended') await ctx.resume();
    },
    push(samples, rate) {
      if (!samples?.length) return;
      const ctx = ensure();
      const buffer = ctx.createBuffer(1, samples.length, rate);
      buffer.getChannelData(0).set(samples);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      const now = ctx.currentTime;
      // Underrun (or first chunk): restart behind a fresh jitter buffer.
      if (playhead < now + 0.02) playhead = now + jitterSeconds;
      // Far ahead of the clock means we are buffering too much: drop to live.
      if (playhead > now + maxLeadSeconds) playhead = now + jitterSeconds;
      source.start(playhead);
      playhead += buffer.duration;
    },
    setVolume(value) {
      volume = Math.min(1, Math.max(0, Number(value) || 0));
      if (gain) gain.gain.value = muted ? 0 : volume;
    },
    setMuted(value) {
      muted = Boolean(value);
      if (gain) gain.gain.value = muted ? 0 : volume;
    },
    get muted() {
      return muted;
    },
    get volume() {
      return volume;
    },
    async close() {
      const ctx = context;
      context = null;
      gain = null;
      analyser = null;
      playhead = 0;
      if (ctx && ctx.state !== 'closed') await ctx.close();
    },
  };
}
