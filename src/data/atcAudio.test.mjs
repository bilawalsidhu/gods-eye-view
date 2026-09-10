import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtcAudioController, playSquelchBurst } from './atcAudio.js';

class MockAudio {
  constructor() {
    this.src = '';
    this.volume = 1;
    this.muted = false;
    this._listeners = new Map();
    this.paused = true;
  }

  addEventListener(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(callback);
  }

  removeEventListener(event, callback) {
    const list = this._listeners.get(event) || [];
    this._listeners.set(event, list.filter((cb) => cb !== callback));
  }

  _emit(event, data) {
    const list = this._listeners.get(event) || [];
    for (const cb of list) cb(data);
  }

  async play() {
    this.paused = false;
    // Asynchronously emit playing
    queueMicrotask(() => this._emit('playing'));
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  removeAttribute(attr) {
    if (attr === 'src') this.src = '';
  }

  load() {}
}

test('atcAudio: initial state and volume defaults', () => {
  const ctrl = new AtcAudioController();
  assert.equal(ctrl.state, 'idle');
  assert.equal(ctrl.volume, 0.8);
  assert.equal(ctrl.muted, false);
  assert.equal(ctrl.currentUrl, null);
  ctrl.destroy();
});

test('atcAudio: volume and muting controls', () => {
  const ctrl = new AtcAudioController({ AudioConstructor: MockAudio });
  ctrl.setVolume(0.5);
  assert.equal(ctrl.volume, 0.5);

  // Clamping test
  ctrl.setVolume(1.5);
  assert.equal(ctrl.volume, 1.0);
  ctrl.setVolume(-0.5);
  assert.equal(ctrl.volume, 0.0);

  ctrl.setMuted(true);
  assert.equal(ctrl.muted, true);
  ctrl.toggleMute();
  assert.equal(ctrl.muted, false);

  ctrl.destroy();
});

test('atcAudio: ducking lowers volume without changing base volume setting', () => {
  const ctrl = new AtcAudioController({ AudioConstructor: MockAudio });
  ctrl.setVolume(0.8);
  ctrl.setDucked(true);
  assert.equal(ctrl.volume, 0.8); // user preference preserved
  ctrl.setDucked(false);
  assert.equal(ctrl.volume, 0.8);
  ctrl.destroy();
});

test('atcAudio: subscription receives state snapshots', () => {
  const ctrl = new AtcAudioController({ AudioConstructor: MockAudio });
  const updates = [];
  const unsubscribe = ctrl.subscribe((state) => updates.push(state));

  ctrl.setVolume(0.3);
  ctrl.setMuted(true);
  unsubscribe();
  ctrl.setVolume(0.9);

  assert.equal(updates.length, 2);
  assert.equal(updates[0].volume, 0.3);
  assert.equal(updates[1].muted, true);
  ctrl.destroy();
});

test('atcAudio: playStream connects and enters playing state with mock audio', async () => {
  const ctrl = new AtcAudioController({ AudioConstructor: MockAudio });
  const success = await ctrl.playStream('https://stream.test/atc.mp3', { squelch: false });

  assert.equal(success, true);
  assert.equal(ctrl.currentUrl, 'https://stream.test/atc.mp3');

  // Wait for playing event
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ctrl.state, 'playing');

  ctrl.stop({ squelch: false });
  assert.equal(ctrl.state, 'squelch');
  assert.equal(ctrl.currentUrl, null);
  ctrl.destroy();
});

test('atcAudio: handles stream errors gracefully without throwing', async () => {
  class FailingAudio extends MockAudio {
    async play() {
      this.paused = true;
      queueMicrotask(() => this._emit('error', new Error('Network error')));
      return Promise.reject(new Error('Connection failed'));
    }
  }

  const ctrl = new AtcAudioController({ AudioConstructor: FailingAudio });
  const success = await ctrl.playStream('https://invalid.stream/atc.mp3', { squelch: false });

  assert.equal(success, false);
  assert.equal(ctrl.state, 'error');
  ctrl.destroy();
});

test('atcAudio: playSquelchBurst runs safely without audio context in test runner', () => {
  assert.doesNotThrow(() => {
    playSquelchBurst(null);
  });
});
