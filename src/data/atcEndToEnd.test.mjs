import test from 'node:test';
import assert from 'node:assert/strict';
import { AtcRadioSystem } from './atcRadio.js';
import { AtcRadioCard } from './atcRadioCard.js';
import { GLOBAL_AIRPORTS } from './atcAirports.js';

// Mock Audio element for Node.js test environment
class MockAudio {
  constructor() {
    this.src = '';
    this.paused = true;
    this.volume = 1.0;
    this.muted = false;
    this._listeners = new Map();
  }
  addEventListener(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
  }
  removeEventListener(event, fn) {
    const list = this._listeners.get(event) || [];
    this._listeners.set(event, list.filter((cb) => cb !== fn));
  }
  _emit(event, data) {
    const list = this._listeners.get(event) || [];
    for (const cb of list) cb(data);
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

// Mock Web Audio AudioContext for squelch burst synthesis
class MockAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
  }
  createBuffer(channels, length, sampleRate) {
    return {
      getChannelData: () => new Float32Array(length),
    };
  }
  createBufferSource() {
    return {
      buffer: null,
      connect: () => {},
      start: () => {},
    };
  }
  createBiquadFilter() {
    return {
      type: 'bandpass',
      frequency: { value: 1000 },
      Q: { value: 1 },
      connect: () => {},
    };
  }
  createGain() {
    return {
      gain: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: () => {},
    };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

// Mock DOM elements for testing Card UI in Node
class MockElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.id = '';
    this.className = '';
    this.hidden = false;
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.textContent = '';
    this.value = '80';
    this.classList = {
      _classes: new Set(),
      add: (cls) => this.classList._classes.add(cls),
      remove: (cls) => this.classList._classes.delete(cls),
      toggle: (cls, force) => {
        if (force === undefined) {
          if (this.classList._classes.has(cls)) this.classList._classes.delete(cls);
          else this.classList._classes.add(cls);
        } else if (force) {
          this.classList._classes.add(cls);
        } else {
          this.classList._classes.delete(cls);
        }
      },
      contains: (cls) => this.classList._classes.has(cls),
    };
  }

  set innerHTML(html) {
    this.children = [];
    const idMatches = [...html.matchAll(/id="([^"]+)"/g)];
    for (const match of idMatches) {
      const el = new MockElement();
      el.id = match[1];
      this.children.push(el);
    }
    const dataFreqMatches = [...html.matchAll(/data-freq-type="([^"]+)"/g)];
    for (const match of dataFreqMatches) {
      const el = new MockElement('button');
      el.setAttribute('data-freq-type', match[1]);
      this.children.push(el);
    }
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.get(k) || null;
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  remove() {
    this.children = [];
  }
  addEventListener(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
  }
  click() {
    const list = this.listeners.get('click') || [];
    for (const cb of list) cb({ target: this });
  }
  dispatchEvent(event) {
    const list = this.listeners.get(event.type) || [];
    for (const cb of list) cb(event);
  }
  querySelector(sel) {
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      return this._find((el) => el.id === id);
    }
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return this._find((el) => el.classList.contains(cls));
    }
    if (sel.startsWith('[data-freq-type=')) {
      const val = sel.match(/\[data-freq-type="?([^"\]]+)"?\]/)?.[1];
      return this._find((el) => el.getAttribute('data-freq-type') === val);
    }
    return null;
  }
  querySelectorAll(sel) {
    const results = [];
    this._findAll(sel, results);
    return results;
  }
  _find(predicate) {
    if (predicate(this)) return this;
    for (const ch of this.children) {
      const found = ch._find(predicate);
      if (found) return found;
    }
    return null;
  }
  _findAll(sel, out) {
    if (sel === '[data-freq-type]' && this.attributes.has('data-freq-type')) {
      out.push(this);
    }
    for (const ch of this.children) ch._findAll(sel, out);
  }
}

test('ATC Radio End-to-End: full flight workflow approaching KAUS', async () => {
  const atcRadio = new AtcRadioSystem({
    AudioConstructor: MockAudio,
    AudioContextConstructor: MockAudioContext,
  });

  // Verify initial state: idle, no airport tuned
  assert.equal(atcRadio.state.airport, null);
  assert.equal(atcRadio.state.frequency, null);
  assert.equal(atcRadio.state.playing, false);

  // 1. Aircraft inbound to Austin (KAUS: 30.1945° N, 97.6699° W) at ~15 NM out, descending
  atcRadio.updateAircraftTelemetry({
    lat: 29.94,
    lon: -97.67,
    altitudeM: 1200,
    verticalRateMps: -2.5,
    groundSpeedKts: 140,
    onGround: false,
    callsign: 'UAL452',
  });

  assert.equal(atcRadio.state.tune.tuned, true);
  assert.equal(atcRadio.state.airport.icao, 'KAUS');
  assert.equal(atcRadio.state.flightPhase, 'approach');
  assert.equal(atcRadio.state.activeFreqType, 'approach');
  assert.equal(atcRadio.state.frequency, '119.000');

  // 2. Start audio playback
  await atcRadio.play();
  assert.equal(atcRadio.state.playing, true);
  assert.ok(atcRadio.audio.audioElement.src.includes('kaus3_twr'));

  // Volume ducking during voice transmission
  atcRadio.duck();
  assert.equal(atcRadio.audio.audioElement.volume, 0.12);
  atcRadio.unduck();
  assert.equal(atcRadio.audio.audioElement.volume, 0.8);

  // 3. Final approach: aircraft descends below 600m and within 4 NM
  atcRadio.updateAircraftTelemetry({
    lat: 30.15,
    lon: -97.67,
    altitudeM: 300,
    verticalRateMps: -2.0,
    groundSpeedKts: 120,
    onGround: false,
    callsign: 'UAL452',
  });

  assert.equal(atcRadio.state.airport.icao, 'KAUS');
  assert.equal(atcRadio.state.activeFreqType, 'tower');
  assert.equal(atcRadio.state.frequency, '121.000');

  // 4. Touchdown on runway: aircraft on ground (switches to ground freq and halts tower audio)
  atcRadio.updateAircraftTelemetry({
    lat: 30.1945,
    lon: -97.6699,
    altitudeM: 165,
    verticalRateMps: 0,
    groundSpeedKts: 20,
    onGround: true,
    callsign: 'UAL452',
  });

  assert.equal(atcRadio.state.flightPhase, 'surface');
  assert.equal(atcRadio.state.activeFreqType, 'ground');
  assert.equal(atcRadio.state.frequency, '121.900');
  assert.equal(atcRadio.state.playing, false);

  // 5. Audio teardown
  atcRadio.stop();
  assert.equal(atcRadio.state.playing, false);
  atcRadio.destroy();
});

test('ATC Radio End-to-End: Card UI reactivity and manual controls', async () => {
  const originalDoc = globalThis.document;
  const container = new MockElement('body');
  globalThis.document = {
    getElementById: (id) => container.querySelector(`#${id}`),
    createElement: (tag) => new MockElement(tag),
  };

  try {
    const atcRadio = new AtcRadioSystem({
      AudioConstructor: MockAudio,
      AudioContextConstructor: MockAudioContext,
    });
    const card = new AtcRadioCard({ atcRadio, container });

    // Initial card UI is hidden
    assert.equal(card.element.hidden, true);

    // Show card
    card.show();
    assert.equal(card.element.hidden, false);

    // Aircraft near London Heathrow (EGLL)
    atcRadio.updateAircraftTelemetry({
      lat: 51.47,
      lon: -0.4543,
      altitudeM: 900,
      verticalRateMps: -2.0,
      groundSpeedKts: 130,
      onGround: false,
      callsign: 'BAW117',
    });

    // Verify DOM reflects EGLL
    const airportLabel = card.element.querySelector('#atc-airport-label');
    assert.ok(airportLabel.textContent.includes('EGLL'));

    const freqDisplay = card.element.querySelector('#atc-frequency-display');
    assert.ok(freqDisplay.textContent === '118.500' || freqDisplay.textContent === '119.725');

    // Test manual frequency switch via card button click
    const atisBtn = card.element.querySelector('[data-freq-type="atis"]');
    assert.ok(atisBtn);
    atisBtn.click();

    assert.equal(atcRadio.state.activeFreqType, 'atis');
    assert.equal(atcRadio.state.frequency, '128.075');

    // Toggle audio via live button
    await atcRadio.toggleAudio();
    assert.equal(atcRadio.state.playing, true);

    // Stop and close
    card.hide();
    assert.equal(card.element.hidden, true);
    atcRadio.stop();
    card.destroy();
    atcRadio.destroy();
  } finally {
    globalThis.document = originalDoc;
  }
});

test('ATC Radio End-to-End: flight handoff between nearby airports', () => {
  const atcRadio = new AtcRadioSystem({
    AudioConstructor: MockAudio,
    AudioContextConstructor: MockAudioContext,
  });

  // Aircraft takes off from JFK (New York)
  atcRadio.updateAircraftTelemetry({
    lat: 40.6413,
    lon: -73.7781,
    altitudeM: 500,
    verticalRateMps: 3.0,
    groundSpeedKts: 160,
    onGround: false,
    callsign: 'JBU123',
  });

  assert.equal(atcRadio.state.airport.icao, 'KJFK');

  // Aircraft flies towards Newark (KEWR: 40.6895° N, 74.1745° W)
  atcRadio.updateAircraftTelemetry({
    lat: 40.6895,
    lon: -74.1745,
    altitudeM: 1000,
    verticalRateMps: -2.0,
    groundSpeedKts: 140,
    onGround: false,
    callsign: 'JBU123',
  });

  assert.equal(atcRadio.state.airport.icao, 'KEWR');
  atcRadio.destroy();
});

test('ATC Radio End-to-End: aircraft out of range gracefully disengages', () => {
  const atcRadio = new AtcRadioSystem({
    AudioConstructor: MockAudio,
    AudioContextConstructor: MockAudioContext,
  });

  // In range of Sydney YSSY (-33.9461, 151.1772)
  atcRadio.updateAircraftTelemetry({
    lat: -33.9461,
    lon: 151.1772,
    altitudeM: 1000,
    verticalRateMps: -1.0,
    groundSpeedKts: 140,
    onGround: false,
    callsign: 'QFA1',
  });
  assert.equal(atcRadio.state.airport.icao, 'YSSY');

  // Middle of the Pacific Ocean (0.0, -140.0) -> far beyond 35 NM of any airport
  atcRadio.updateAircraftTelemetry({
    lat: 0.0,
    lon: -140.0,
    altitudeM: 11000,
    verticalRateMps: 0,
    groundSpeedKts: 450,
    onGround: false,
    callsign: 'QFA1',
  });

  // Beyond range: no airport within max range (35 NM)
  assert.equal(atcRadio.state.tune.inRange, false);
  assert.equal(atcRadio.state.tune.status, 'no-station');
  assert.equal(atcRadio.state.flightPhase, 'enroute');
  atcRadio.destroy();
});
