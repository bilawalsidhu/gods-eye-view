import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtcRadioSystem } from './atcRadio.js';
import { AtcAudioController } from './atcAudio.js';

class MockAudio {
  constructor() {
    this.src = '';
    this.volume = 1;
    this.muted = false;
    this._listeners = new Map();
    this.paused = true;
  }
  addEventListener(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(cb);
  }
  removeEventListener() {}
  _emit(event, data) {
    for (const cb of this._listeners.get(event) || []) cb(data);
  }
  async play() {
    this.paused = false;
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

test('atcRadio: initializes with nominal defaults', () => {
  const audio = new AtcAudioController({ AudioConstructor: MockAudio });
  const radio = new AtcRadioSystem({ audioController: audio });

  assert.equal(radio.autoTuneEnabled, true);
  assert.equal(radio.autoPlayEnabled, false);
  assert.equal(radio.currentTune.tuned, false);
  assert.equal(radio.state.audioState, 'idle');

  radio.destroy();
});

test('atcRadio: tracks aircraft proximity and auto-tunes to nearest airport', () => {
  const audio = new AtcAudioController({ AudioConstructor: MockAudio });
  const radio = new AtcRadioSystem({ audioController: audio });

  // Aircraft on arrival into San Francisco KSFO (37.6188, -122.3750)
  radio.updateAircraftTelemetry({
    lat: 37.65,
    lon: -122.38,
    altitudeM: 800,
    verticalRateMps: -3.5,
    groundSpeedKts: 135,
    callsign: 'UAL456',
  });

  const tune = radio.currentTune;
  assert.equal(tune.tuned, true);
  assert.equal(tune.inRange, true);
  assert.equal(tune.airport.icao, 'KSFO');
  assert.equal(tune.phase, 'approach');
  assert.equal(tune.frequencyMHz, '120.500'); // KSFO Tower

  radio.destroy();
});

test('atcRadio: manual tuning overrides proximity auto-tune', () => {
  const audio = new AtcAudioController({ AudioConstructor: MockAudio });
  const radio = new AtcRadioSystem({ audioController: audio });

  radio.updateAircraftTelemetry({
    lat: 37.65,
    lon: -122.38,
    altitudeM: 800,
  });
  assert.equal(radio.currentTune.airport.icao, 'KSFO');

  // Manually switch to San Francisco (KSFO) Approach
  radio.tuneAirport('KSFO', 'approach');
  assert.equal(radio.autoTuneEnabled, false);
  assert.equal(radio.currentTune.airport.icao, 'KSFO');
  assert.equal(radio.currentTune.frequencyMHz, '128.325');
  assert.equal(radio.currentTune.freqType, 'approach');

  // Re-enable auto-tune restores proximity
  radio.setAutoTune(true);
  assert.equal(radio.autoTuneEnabled, true);
  assert.equal(radio.currentTune.airport.icao, 'KSFO');

  radio.destroy();
});

test('atcRadio: frequency selection switches frequency type on current airport', () => {
  const audio = new AtcAudioController({ AudioConstructor: MockAudio });
  const radio = new AtcRadioSystem({ audioController: audio });

  radio.updateAircraftTelemetry({
    lat: 30.19,
    lon: -97.66,
    altitudeM: 50,
    onGround: true,
  });

  assert.equal(radio.currentTune.airport.icao, 'KAUS');

  // Manually select ATIS
  radio.selectFrequency('atis');
  assert.equal(radio.currentTune.freqType, 'atis');
  assert.equal(radio.currentTune.frequencyMHz, '128.875');

  radio.destroy();
});

test('atcRadio: autoPlay starts stream when entering airport coverage with custom stream', async () => {
  const mockStorage = new Map();
  const storage = {
    getItem: (k) => mockStorage.get(k) || null,
    setItem: (k, v) => mockStorage.set(k, String(v)),
    removeItem: (k) => mockStorage.delete(k),
  };
  storage.setItem('gev_atc_custom_stream_KLAX', 'https://streams.test/klax.mp3');

  const audio = new AtcAudioController({ AudioConstructor: MockAudio });
  const radio = new AtcRadioSystem({ audioController: audio, autoPlayEnabled: true, storage });

  radio.updateAircraftTelemetry({
    lat: 33.94,
    lon: -118.40,
    altitudeM: 500,
    callsign: 'AAL100',
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(audio.state, 'playing');
  assert.equal(audio.currentUrl, 'https://streams.test/klax.mp3');

  radio.destroy();
});

test('atcRadio: setAutoTune(false) snapshots and locks currently tuned station', () => {
  const audio = new AtcAudioController({ AudioConstructor: MockAudio });
  const radio = new AtcRadioSystem({ audioController: audio });

  // Aircraft at Austin
  radio.updateAircraftTelemetry({
    lat: 30.19,
    lon: -97.66,
    altitudeM: 50,
    onGround: true,
  });
  assert.equal(radio.currentTune.airport.icao, 'KAUS');

  // Disable auto-tune - freezes KAUS
  radio.setAutoTune(false);
  assert.equal(radio.autoTuneEnabled, false);

  // Teleport aircraft to Los Angeles (KLAX)
  radio.updateAircraftTelemetry({
    lat: 33.94,
    lon: -118.40,
    altitudeM: 500,
  });
  // Station remains frozen on KAUS because auto-tune is off
  assert.equal(radio.currentTune.airport.icao, 'KAUS');

  // Re-enable auto-tune - dynamically tunes to KLAX
  radio.setAutoTune(true);
  assert.equal(radio.autoTuneEnabled, true);
  assert.equal(radio.currentTune.airport.icao, 'KLAX');

  radio.destroy();
});

test('atcRadio: manages custom stream URLs and exposes liveAtcUrl', () => {
  const mockStorage = new Map();
  const storage = {
    getItem: (k) => mockStorage.get(k) || null,
    setItem: (k, v) => mockStorage.set(k, String(v)),
    removeItem: (k) => mockStorage.delete(k),
  };

  const audio = new AtcAudioController({ AudioConstructor: MockAudio });
  const radio = new AtcRadioSystem({ audioController: audio, storage });

  radio.updateAircraftTelemetry({
    lat: 30.19,
    lon: -97.66,
    altitudeM: 50,
    onGround: true,
  });

  assert.equal(radio.currentTune.airport.icao, 'KAUS');
  assert.equal(radio.liveAtcUrl, 'https://www.liveatc.net/search/?icao=kaus');
  assert.equal(radio.hasCustomStream, false);
  assert.equal(radio.streamUrl, null);

  // Set invalid custom stream
  const badRes = radio.setCustomStreamUrl('http://insecure.test/stream.mp3');
  assert.equal(badRes.ok, false);
  assert.equal(radio.hasCustomStream, false);

  // Set valid HTTPS custom stream
  const goodRes = radio.setCustomStreamUrl('https://secure.test/kaus.mp3');
  assert.equal(goodRes.ok, true);
  assert.equal(radio.hasCustomStream, true);
  assert.equal(radio.streamUrl, 'https://secure.test/kaus.mp3');

  // Remove custom stream
  const removed = radio.removeCustomStreamUrl();
  assert.equal(removed, true);
  assert.equal(radio.hasCustomStream, false);
  assert.equal(radio.streamUrl, null);

  radio.destroy();
});

