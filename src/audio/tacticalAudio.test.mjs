import test from 'node:test';
import assert from 'node:assert/strict';

import { TacticalAudioEngine, getTacticalAudio } from './tacticalAudio.js';
import { CockpitAmbiance } from './cockpitAmbiance.js';

function createMockAudioContext() {
  const nodes = [];
  const createMockNode = (type) => {
    const node = {
      type,
      gain: {
        value: 1,
        setValueAtTime: (v) => { node.gain.value = v; },
        linearRampToValueAtTime: (v) => { node.gain.value = v; },
        exponentialRampToValueAtTime: (v) => { node.gain.value = v; },
        setTargetAtTime: (v) => { node.gain.value = v; },
      },
      frequency: {
        value: 440,
        setValueAtTime: (v) => { node.frequency.value = v; },
        exponentialRampToValueAtTime: (v) => { node.frequency.value = v; },
        setTargetAtTime: (v) => { node.frequency.value = v; },
      },
      Q: {
        value: 1,
        setValueAtTime: (v) => { node.Q.value = v; },
      },
      pan: {
        value: 0,
        setTargetAtTime: (v) => { node.pan.value = v; },
      },
      connect: (target) => { node._target = target; return target; },
      disconnect: () => { node._target = null; },
      start: () => { node._started = true; },
      stop: () => { node._stopped = true; },
    };
    nodes.push(node);
    return node;
  };

  return {
    state: 'running',
    currentTime: 10,
    sampleRate: 44100,
    destination: { type: 'destination' },
    createGain: () => createMockNode('gain'),
    createOscillator: () => createMockNode('oscillator'),
    createBiquadFilter: () => createMockNode('biquadFilter'),
    createStereoPanner: () => createMockNode('stereoPanner'),
    createBuffer: (channels, length, rate) => ({
      channels,
      length,
      rate,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => createMockNode('bufferSource'),
    resume: async () => {},
    close: async () => {},
  };
}

test('TacticalAudioEngine initializes lazily and handles volume changes', () => {
  const mockCtx = createMockAudioContext();
  const engine = new TacticalAudioEngine({ audioContextRef: () => mockCtx });

  assert.equal(engine.getMasterVolume(), 0.85);
  engine.setMasterVolume(0.5);
  assert.equal(engine.getMasterVolume(), 0.5);

  assert.equal(engine.isMuted(), false);
  engine.setMuted(true);
  assert.equal(engine.isMuted(), true);
  engine.setMuted(false);
  assert.equal(engine.isMuted(), false);

  engine.setCategoryVolume('sfx', 0.9);
  assert.equal(engine.getCategoryVolume('sfx'), 0.9);
});

test('TacticalAudioEngine produces sound cues without error', () => {
  const mockCtx = createMockAudioContext();
  const engine = new TacticalAudioEngine({ audioContextRef: () => mockCtx });

  assert.doesNotThrow(() => engine.playLock());
  assert.doesNotThrow(() => engine.playRelease());
  assert.doesNotThrow(() => engine.playClick());
  assert.doesNotThrow(() => engine.playClack());
  assert.doesNotThrow(() => engine.playSpoolUp());
  assert.doesNotThrow(() => engine.playSpoolDown());
  assert.doesNotThrow(() => engine.playStyleChange());
  assert.doesNotThrow(() => engine.playAlert());
  assert.doesNotThrow(() => engine.playGeofenceBreach());
  assert.doesNotThrow(() => engine.playGlobeReset());
  assert.doesNotThrow(() => engine.playRadioTuning());
});

test('CockpitAmbiance starts, updates telemetry, and stops safely', () => {
  const mockCtx = createMockAudioContext();
  const engine = new TacticalAudioEngine({ audioContextRef: () => mockCtx });
  const ambiance = new CockpitAmbiance({ audioEngine: engine });

  assert.equal(ambiance.isActive(), false);
  ambiance.start();
  assert.equal(ambiance.isActive(), true);

  assert.doesNotThrow(() => {
    ambiance.updateTelemetry({ speedKts: 450, rollDeg: 15, verticalRateFpm: 1200 });
  });

  ambiance.stop();
});
