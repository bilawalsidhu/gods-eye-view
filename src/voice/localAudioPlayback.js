/**
 * Plays assistant speech from the local voice server through Web Audio and
 * exposes the output as a MediaStream so the dock visualizer can meter it.
 * Accepts whole encoded files (binary frames) and streamed PCM16 chunks
 * ({ type: 'audio_chunk', turnId, seq, sampleRate, pcm16 }).
 */
export function createLocalPlayback({
  onSpeaking,
  onIdle,
  attachVisualizer,
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
} = {}) {
  let context = null;
  let gain = null;
  let sink = null;
  let nextStartAt = 0;
  let activeTurn = null;
  let expectSeq = 0;
  let scheduled = 0;
  const buffered = new Map();
  let generation = 0;

  function ensureContext() {
    if (context) return context;
    if (typeof AudioContextImpl !== 'function') return null;
    context = new AudioContextImpl();
    context.resume?.().catch?.(() => {});
    gain = context.createGain();
    gain.connect(context.destination);
    if (typeof context.createMediaStreamDestination === 'function') {
      sink = context.createMediaStreamDestination();
      gain.connect(sink);
      attachVisualizer?.(sink.stream);
    }
    return context;
  }

  function schedule(buffer) {
    const ctx = ensureContext();
    if (!ctx || !buffer) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const at = Math.max(ctx.currentTime + 0.02, nextStartAt);
    const myGeneration = generation;
    source.onended = () => {
      if (myGeneration !== generation) return;
      scheduled--;
      if (scheduled <= 0) {
        scheduled = 0;
        onIdle?.();
      }
    };
    if (scheduled === 0) onSpeaking?.();
    scheduled++;
    source.start(at);
    nextStartAt = at + buffer.duration;
  }

  function pcmToBuffer({ pcm16, sampleRate }) {
    const ctx = ensureContext();
    if (!ctx || !pcm16) return null;
    const binary = atob(pcm16);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const samples = new Int16Array(
      bytes.buffer,
      0,
      Math.floor(bytes.byteLength / 2),
    );
    if (!samples.length) return null;
    const buffer = ctx.createBuffer(
      1,
      samples.length,
      Number(sampleRate) || 22050,
    );
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
    return buffer;
  }

  return {
    get speaking() {
      return scheduled > 0;
    },
    /** Whole encoded file (WAV/OGG) from a binary frame. */
    async enqueueEncoded(bytes) {
      const ctx = ensureContext();
      if (!ctx || !bytes?.byteLength) return;
      const myGeneration = generation;
      try {
        const buffer = await ctx.decodeAudioData(bytes.slice(0));
        if (myGeneration === generation) schedule(buffer);
      } catch {
        /* Undecodable audio is dropped; the text reply already arrived. */
      }
    },
    /** Streamed PCM chunk; reorders by seq within a turn. */
    handle(frame) {
      if (!frame || frame.type !== 'audio_chunk') return;
      const turnId = frame.turnId ?? 'default';
      if (turnId !== activeTurn) {
        activeTurn = turnId;
        expectSeq = 0;
        buffered.clear();
      }
      const seq = Number.isFinite(frame.seq) ? frame.seq : expectSeq;
      buffered.set(seq, frame);
      while (buffered.has(expectSeq)) {
        const next = buffered.get(expectSeq);
        buffered.delete(expectSeq);
        expectSeq++;
        schedule(pcmToBuffer(next));
      }
    },
    /** Drop anything queued and silence current playback. */
    interrupt() {
      generation++;
      buffered.clear();
      activeTurn = null;
      expectSeq = 0;
      nextStartAt = 0;
      if (scheduled > 0) {
        scheduled = 0;
        onIdle?.();
      }
      if (gain && context) {
        try {
          gain.disconnect();
        } catch {
          /* no-op */
        }
        gain = context.createGain();
        gain.connect(context.destination);
        if (sink) gain.connect(sink);
      }
    },
    stop() {
      generation++;
      buffered.clear();
      scheduled = 0;
      nextStartAt = 0;
      activeTurn = null;
      const ctx = context;
      context = null;
      gain = null;
      sink = null;
      ctx?.close?.().catch?.(() => {});
    },
  };
}
