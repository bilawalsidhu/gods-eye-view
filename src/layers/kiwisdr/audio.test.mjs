import test from 'node:test';
import assert from 'node:assert/strict';
import { createKiwiAudio } from './audio.js';

function fakeContext() {
  const starts = [];
  class Ctx {
    constructor() {
      this.currentTime = 0;
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = {};
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    createAnalyser() {
      return { connect() {} };
    }
    createBuffer(_c, n, rate) {
      const data = new Float32Array(n);
      return { duration: n / rate, getChannelData: () => data };
    }
    createBufferSource() {
      return {
        connect() {},
        start: (t) => starts.push(t),
      };
    }
    close() {
      this.state = 'closed';
      return Promise.resolve();
    }
  }
  return { Ctx, starts };
}

test('schedules chunks back to back behind a jitter buffer', () => {
  const { Ctx, starts } = fakeContext();
  const audio = createKiwiAudio({ AudioContextImpl: Ctx, jitterSeconds: 0.3 });
  audio.push(new Float32Array(1200), 12000); // 0.1s
  audio.push(new Float32Array(1200), 12000);
  assert.equal(starts[0], 0.3);
  assert.ok(Math.abs(starts[1] - 0.4) < 1e-9);
});

test('resynchronises after an underrun and after over-buffering', () => {
  const { Ctx, starts } = fakeContext();
  const audio = createKiwiAudio({
    AudioContextImpl: Ctx,
    jitterSeconds: 0.3,
    maxLeadSeconds: 1,
  });
  audio.push(new Float32Array(1200), 12000);
  for (let i = 0; i < 15; i++) audio.push(new Float32Array(1200), 12000);
  // Lead grew past 1s, so the playhead was pulled back to live.
  assert.ok(Math.max(...starts) <= 1.31);
});

test('volume clamps and mute is remembered', () => {
  const { Ctx } = fakeContext();
  const audio = createKiwiAudio({ AudioContextImpl: Ctx });
  audio.setVolume(5);
  assert.equal(audio.volume, 1);
  audio.setMuted(true);
  assert.equal(audio.muted, true);
  assert.equal(audio.sampleRate, 48000);
});

test('throws a clear error when Web Audio is missing', () => {
  const audio = createKiwiAudio({ AudioContextImpl: null });
  assert.throws(() => audio.sampleRate, /Web Audio/);
});
