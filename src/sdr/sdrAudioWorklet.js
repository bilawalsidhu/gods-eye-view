class GevSdrAudioPlayer extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const config = options.processorOptions || {};
    const maxFrames = Number.isFinite(config.maxFrames)
      ? Math.floor(config.maxFrames)
      : Math.round(sampleRate * 0.256);
    this.maxFrames = Math.min(Math.round(sampleRate), Math.max(1, maxFrames));
    const prebufferFrames = Number.isFinite(config.prebufferFrames)
      ? Math.floor(config.prebufferFrames)
      : Math.round(sampleRate * 0.08);
    this.prebufferFrames = Math.min(
      Math.max(0, prebufferFrames),
      this.maxFrames,
    );
    this.queue = [];
    this.offset = 0;
    this.queuedFrames = 0;
    this.volume = 0.8;
    this.sessionId = null;
    this.enabled = false;
    this.active = false;
    this.playing = false;
    this.diagnosticsEnabled = false;
    this.diagnosticFrames = 0;
    this.stats = {
      enqueued: 0,
      consumed: 0,
      empty: 0,
      waiting: 0,
      dropped: 0,
      cleared: 0,
      underruns: 0,
      output: 0,
    };
    this.port.onmessage = (event) => this.receive(event.data);
  }

  reportStats() {
    this.port.postMessage({
      type: 'audioStats',
      ...this.stats,
      queued: this.queuedFrames,
      active: this.active,
      sessionId: this.sessionId,
      enabled: this.enabled,
      playing: this.playing,
    });
  }

  receive(message) {
    if (message?.type === 'session') {
      if (!Number.isSafeInteger(message.sessionId) || message.sessionId < 0)
        return;
      if (message.enabled === true) {
        // A retired epoch cannot be re-enabled by a late control message.
        if (
          this.sessionId !== null &&
          (message.sessionId < this.sessionId ||
            (message.sessionId === this.sessionId && !this.enabled))
        )
          return;
        if (this.sessionId !== message.sessionId) {
          this.receive({ type: 'clear' });
          this.sessionId = message.sessionId;
        }
        this.enabled = true;
      } else if (
        message.enabled === false &&
        this.sessionId === message.sessionId
      ) {
        this.enabled = false;
        this.receive({ type: 'clear' });
      }
    } else if (
      message?.type === 'samples' &&
      this.enabled &&
      message.sessionId === this.sessionId &&
      message.samples instanceof Float32Array &&
      message.samples.length > 0
    ) {
      this.active = true;
      this.queue.push(message.samples);
      this.queuedFrames += message.samples.length;
      this.stats.enqueued += message.samples.length;
      let drop = Math.max(0, this.queuedFrames - this.maxFrames);
      this.stats.dropped += drop;
      while (drop > 0 && this.queue.length > 0) {
        const count = Math.min(drop, this.queue[0].length - this.offset);
        this.offset += count;
        this.queuedFrames -= count;
        drop -= count;
        if (this.offset === this.queue[0].length) {
          this.queue.shift();
          this.offset = 0;
        }
      }
    } else if (message?.type === 'clear') {
      this.stats.cleared += this.queuedFrames;
      this.queue.length = 0;
      this.offset = 0;
      this.queuedFrames = 0;
      this.active = false;
      this.playing = false;
      this.diagnosticFrames = 0;
      if (this.diagnosticsEnabled) this.reportStats();
    } else if (message?.type === 'volume') {
      this.volume = Math.max(0, Math.min(1, Number(message.value) || 0));
    } else if (message?.type === 'diagnostics') {
      this.diagnosticsEnabled = message.enabled === true;
      this.diagnosticFrames = 0;
    } else if (message?.type === 'stats') {
      this.reportStats();
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);
    if (!this.active) return true;
    this.stats.output += output.length;
    if (!this.playing && this.queuedFrames >= this.prebufferFrames)
      this.playing = true;
    if (!this.playing) {
      this.stats.waiting += output.length;
    } else {
      let written = 0;
      while (written < output.length && this.queue.length > 0) {
        const samples = this.queue[0];
        const count = Math.min(
          output.length - written,
          samples.length - this.offset,
        );
        for (let index = 0; index < count; index += 1)
          output[written + index] = samples[this.offset + index] * this.volume;
        written += count;
        this.offset += count;
        this.queuedFrames -= count;
        this.stats.consumed += count;
        if (this.offset === samples.length) {
          this.queue.shift();
          this.offset = 0;
        }
      }
      if (written < output.length) {
        this.stats.empty += output.length - written;
        this.stats.underruns += 1;
        this.playing = false;
      }
    }
    if (this.diagnosticsEnabled) {
      this.diagnosticFrames += output.length;
      if (this.diagnosticFrames >= sampleRate) {
        this.diagnosticFrames %= sampleRate;
        this.reportStats();
      }
    }
    return true;
  }
}

registerProcessor('gev-sdr-audio-player', GevSdrAudioPlayer);
